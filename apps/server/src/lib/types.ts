/** 领域内的小类型集合（A2/A4） */

export type VerifyChannel = 'email' | 'phone';
export type CodePurpose = 'register' | 'reset' | 'bind';

/** 当前注册策略固定为开放注册 */
export type RegistrationMode = 'open';
