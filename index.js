/** 插件入口转发。实现在 lib/core/index.js。 */
export {
  apply, inject, name,
  resolveDshHome, captureCompaction, memoryDir, buildMemoryContext, snapshotAssembly,
  buildReadToolDefinition, buildWriteToolDefinition, listMemories, readMemorySection, writeMemory, READ_TOOL_NAME, WRITE_TOOL_NAME,
  DEFAULT_OPTIONS, FOLLOW_DEPTH, REMINDER_CONTEXT, REMINDER_SYSTEM, optionsPath, normalizeOptions, readOptionsSync, writeOptions
} from './lib/core/index.js'

// 0.3.0 工具组：读原文、固化工具脚本、直接跑。
export {
  buildToolCreateReadDefinition, buildToolCreateWriteDefinition, buildToolCallToolDefinition,
  readBodyOf, parseBlocks, outlineOf, locateMemory,
  TOOL_CREATE_READ_NAME, TOOL_CREATE_WRITE_NAME, TOOL_CALL_TOOL_NAME
} from './lib/core/schema-tools.js'
export {
  installToolScript, listToolScripts, loadToolScript, catalogText, normalizeToolScript,
  toolSequenceRoot, toolScriptDir, TOOL_SEQUENCE_DIR
} from './lib/core/schema.js'
export { runScript } from './lib/core/schema-runner.js'
