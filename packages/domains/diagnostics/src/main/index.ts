export {
  registerDiagnosticsHandlers,
  registerProcessDiagnostics,
  stopDiagnostics,
  recordDiagnosticEvent,
  flushWriteQueue,
  getDiagnosticsConfig,
  setIpcSuccessHook,
  type IpcSuccessHook,
  type DiagnosticsEventRow
} from './service'
export {
  selfHealDiagnosticsDb,
  scheduleSalvageMergeForAll,
  mergeSalvage,
  type SelfHealResult
} from './self-heal'
