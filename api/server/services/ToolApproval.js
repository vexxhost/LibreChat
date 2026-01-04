const { logger } = require('@librechat/data-schemas');
const { CacheKeys, Constants } = require('librechat-data-provider');
const { GraphEvents, StepTypes } = require('@librechat/agents');
const { sendEvent, GenerationJobManager } = require('@librechat/api');
const { getFlowStateManager, getMCPServersRegistry } = require('~/config');
const { getLogStores } = require('~/cache');
const { nanoid } = require('nanoid');

/** TTL for tool approval flows: 24 hours to effectively "wait indefinitely" */
const APPROVAL_FLOW_TTL = 24 * 60 * 60 * 1000;

/**
 * Get approval mode for a specific MCP tool
 * @param {string} serverName - MCP server name
 * @param {string} toolName - Tool name
 * @param {string} userId - User ID for user-specific configs
 * @returns {Promise<'always_approved' | 'ask' | 'blocked'>}
 */
async function getToolApprovalMode(serverName, toolName, userId) {
  const registry = getMCPServersRegistry();
  const serverConfig = await registry.getServerConfig(serverName, userId);

  if (!serverConfig) {
    return 'always_approved'; // Default if no config
  }

  // Check per-tool override first
  const override = serverConfig.toolApprovalOverrides?.[toolName];
  if (override) {
    return override;
  }

  // Fall back to server default
  return serverConfig.toolApproval || 'always_approved';
}

/**
 * Emit tool approval required event to frontend
 * @param {Object} params
 * @param {ServerResponse} params.res - Express response object
 * @param {string | null} params.streamId - Stream ID for resumable mode
 * @param {string} params.stepId - Step ID for the tool call
 * @param {Object} params.toolCall - Tool call object
 * @param {Object} params.approvalData - Approval data to send
 */
function emitApprovalRequired({ res, streamId, stepId, toolCall, approvalData }) {
  const data = {
    id: stepId,
    delta: {
      type: StepTypes.TOOL_CALLS,
      tool_calls: [{ ...toolCall, args: '' }],
      approval: {
        required: true,
        status: 'pending',
        ...approvalData,
      },
    },
  };

  const eventData = { event: GraphEvents.ON_RUN_STEP_DELTA, data };

  if (streamId) {
    GenerationJobManager.emitChunk(streamId, eventData);
  } else {
    sendEvent(res, eventData);
  }
}

/**
 * Wait for user approval of a tool call
 * @param {Object} params
 * @param {string} params.flowId - Flow ID for tracking the approval
 * @param {string} params.userId - User ID
 * @param {string} params.conversationId - Conversation ID
 * @param {string} params.messageId - Message ID
 * @param {string} params.toolCallId - Tool call ID
 * @param {string} params.toolName - Tool name
 * @param {string} params.serverName - MCP server name
 * @param {Record<string, unknown>} params.args - Tool arguments
 * @param {AbortSignal} [params.signal] - Abort signal
 * @returns {Promise<{ approved: boolean }>}
 */
async function waitForApproval({
  flowId,
  userId,
  conversationId,
  messageId,
  toolCallId,
  toolName,
  serverName,
  args,
  signal,
}) {
  const flowsCache = getLogStores(CacheKeys.FLOWS);
  // Create a new FlowStateManager with longer TTL for approval flows
  const { FlowStateManager } = require('@librechat/api');
  const flowManager = new FlowStateManager(flowsCache, { ttl: APPROVAL_FLOW_TTL });

  const metadata = {
    userId,
    conversationId,
    messageId,
    toolCallId,
    toolName,
    serverName,
    args,
  };

  logger.debug(`[ToolApproval] Creating approval flow: ${flowId}`, { toolName, serverName });

  try {
    const result = await flowManager.createFlow(flowId, 'tool_approval', metadata, signal);
    return result;
  } catch (error) {
    if (error.message?.includes('aborted')) {
      logger.info(`[ToolApproval] Flow aborted: ${flowId}`);
      throw new Error(`Tool approval cancelled for "${toolName}"`);
    }
    throw error;
  }
}

/**
 * Complete a tool approval flow
 * @param {string} flowId - Flow ID
 * @param {boolean} approved - Whether the tool call was approved
 * @returns {Promise<boolean>}
 */
async function completeApproval(flowId, approved) {
  const flowsCache = getLogStores(CacheKeys.FLOWS);
  const { FlowStateManager } = require('@librechat/api');
  const flowManager = new FlowStateManager(flowsCache, { ttl: APPROVAL_FLOW_TTL });

  const result = { approved, timestamp: Date.now() };
  const success = await flowManager.completeFlow(flowId, 'tool_approval', result);

  logger.debug(`[ToolApproval] Completed approval flow: ${flowId}`, { approved, success });
  return success;
}

/**
 * Get a pending approval flow state
 * @param {string} flowId - Flow ID
 * @returns {Promise<Object | null>}
 */
async function getApprovalFlowState(flowId) {
  const flowsCache = getLogStores(CacheKeys.FLOWS);
  const { FlowStateManager } = require('@librechat/api');
  const flowManager = new FlowStateManager(flowsCache, { ttl: APPROVAL_FLOW_TTL });

  return flowManager.getFlowState(flowId, 'tool_approval');
}

/**
 * Generate a flow ID for tool approval
 * @param {string} userId - User ID
 * @param {string} toolCallId - Tool call ID
 * @returns {string}
 */
function generateApprovalFlowId(userId, toolCallId) {
  return `tool_approval:${userId}:${toolCallId}:${nanoid(8)}`;
}

/**
 * Check if a tool call requires approval and handle the approval flow
 * @param {Object} params
 * @param {ServerResponse} params.res - Express response object
 * @param {string | null} params.streamId - Stream ID for resumable mode
 * @param {string} params.userId - User ID
 * @param {string} params.conversationId - Conversation ID
 * @param {string} params.messageId - Message ID (run_id)
 * @param {string} params.toolName - Tool name
 * @param {string} params.serverName - MCP server name
 * @param {string} params.toolCallId - Tool call ID
 * @param {string} params.stepId - Step ID
 * @param {Object} params.toolCall - Tool call object for event emission
 * @param {Record<string, unknown>} params.args - Tool arguments
 * @param {AbortSignal} [params.signal] - Abort signal
 * @returns {Promise<void>} Resolves when approved, throws on rejection or block
 */
async function checkToolApproval({
  res,
  streamId,
  userId,
  conversationId,
  messageId,
  toolName,
  serverName,
  toolCallId,
  stepId,
  toolCall,
  args,
  signal,
}) {
  const approvalMode = await getToolApprovalMode(serverName, toolName, userId);

  logger.debug(`[ToolApproval] Checking approval for ${toolName}@${serverName}`, {
    approvalMode,
    userId,
  });

  if (approvalMode === 'always_approved') {
    // No approval needed, continue execution
    return;
  }

  if (approvalMode === 'blocked') {
    throw new Error(
      `Tool "${toolName}" from server "${serverName}" is blocked by administrator configuration`,
    );
  }

  // Mode is 'ask' - require user approval
  const flowId = generateApprovalFlowId(userId, toolCallId);

  // Emit approval required event to frontend
  emitApprovalRequired({
    res,
    streamId,
    stepId,
    toolCall,
    approvalData: {
      flowId,
      toolName,
      serverName,
    },
  });

  logger.info(`[ToolApproval] Waiting for user approval: ${flowId}`, { toolName, serverName });

  // Wait for user decision
  const result = await waitForApproval({
    flowId,
    userId,
    conversationId,
    messageId,
    toolCallId,
    toolName,
    serverName,
    args,
    signal,
  });

  if (!result.approved) {
    logger.info(`[ToolApproval] User rejected tool call: ${flowId}`, { toolName, serverName });
    throw new Error(`User rejected tool call "${toolName}" from server "${serverName}"`);
  }

  logger.info(`[ToolApproval] User approved tool call: ${flowId}`, { toolName, serverName });
}

module.exports = {
  getToolApprovalMode,
  checkToolApproval,
  completeApproval,
  getApprovalFlowState,
  generateApprovalFlowId,
  APPROVAL_FLOW_TTL,
};
