/**
 * 领域状态枚举与常量
 */

/** 固件版本状态 */
export const FirmwareStatus = Object.freeze({
  /** 可用于新建批次 */
  ACTIVE: 'ACTIVE',
  /** 已作废：禁止新建批次，未发布批次停住并回退 */
  REVOKED: 'REVOKED',
});

/** 批次状态 */
export const BatchStatus = Object.freeze({
  /** 已圈选设备，尚未启动，无指令 */
  PENDING: 'PENDING',
  /** 下发中 */
  RUNNING: 'RUNNING',
  /** 本批次升级指令全部到达终态（成功/失败/取消），待人工发布 */
  COMPLETED: 'COMPLETED',
  /** 已发布：固件作废时保持原样，不回退 */
  PUBLISHED: 'PUBLISHED',
  /** 因固件作废停住 */
  HALTED: 'HALTED',
});

/** 指令状态 */
export const OrderStatus = Object.freeze({
  /** 排队中，等待站点空闲槽位 */
  QUEUED: 'QUEUED',
  /** 已下发，等待设备回执 */
  DISPATCHED: 'DISPATCHED',
  /** 回执成功 */
  SUCCESS: 'SUCCESS',
  /** 回执失败 */
  FAILED: 'FAILED',
  /** 批次停住时被取消（从未下发） */
  CANCELED: 'CANCELED',
});

/** 指令类型 */
export const OrderKind = Object.freeze({
  /** 升级指令 */
  UPGRADE: 'UPGRADE',
  /** 回退指令（作废后把设备刷回升级前版本） */
  ROLLBACK: 'ROLLBACK',
});

/** 对账问题类别 */
export const IssueCategory = Object.freeze({
  /** 漏升：计划要求升到目标版本，月底实际不在目标版本 */
  MISSED: 'MISSED',
  /** 错升：设备实际版本与资产系统记录不一致 */
  WRONG_VERSION: 'WRONG_VERSION',
  /** 回退失败：作废后回退指令收到失败回执 */
  ROLLBACK_FAILED: 'ROLLBACK_FAILED',
});

export const ISSUE_LABELS = Object.freeze({
  MISSED: '漏升',
  WRONG_VERSION: '错升',
  ROLLBACK_FAILED: '回退失败',
});
