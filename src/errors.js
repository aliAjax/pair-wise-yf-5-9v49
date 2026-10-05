/**
 * 业务错误类型，便于调用方按类型处理
 */
export class AppError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

export class NotFoundError extends AppError {
  constructor(entity, id) {
    super(`${entity} 不存在: ${id}`, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends AppError {
  constructor(message) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

export class ConflictError extends AppError {
  constructor(message) {
    super(message, 'CONFLICT');
    this.name = 'ConflictError';
  }
}

/** 固件版本已作废 */
export class FirmwareRevokedError extends AppError {
  constructor(version) {
    super(`固件版本已作废，禁止操作: ${version}`, 'FIRMWARE_REVOKED');
    this.name = 'FirmwareRevokedError';
    this.firmwareVersion = version;
  }
}

/** 站点断网，无法下发 */
export class SiteOfflineError extends AppError {
  constructor(siteId) {
    super(`站点断网中，无法下发: ${siteId}`, 'SITE_OFFLINE');
    this.name = 'SiteOfflineError';
    this.siteId = siteId;
  }
}
