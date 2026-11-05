import { beforeEach, describe, expect, it, vi } from 'vitest';

const smsMocks = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  configs: [] as unknown[],
  send: vi.fn(),
  check: vi.fn(),
}));

vi.mock('../lib/settings.js', () => ({
  getSetting: (key: string) => smsMocks.settings[key] ?? null,
}));

vi.mock('@alicloud/dypnsapi20170525', () => {
  class Request {
    constructor(values: Record<string, unknown> = {}) {
      Object.assign(this, values);
    }
  }
  return {
    SendSmsVerifyCodeRequest: Request,
    CheckSmsVerifyCodeRequest: Request,
    default: {
      default: class {
        constructor(config: unknown) {
          smsMocks.configs.push(config);
        }
        sendSmsVerifyCode(request: unknown) {
          return smsMocks.send(request);
        }
        checkSmsVerifyCode(request: unknown) {
          return smsMocks.check(request);
        }
      },
    },
  };
});

import { checkAliyunSmsVerifyCode, sendAliyunSmsVerifyCode } from '../lib/aliyunSms.js';

beforeEach(() => {
  smsMocks.settings = {
    ALIYUN_ACCESS_KEY_ID: 'test-access-key-id',
    ALIYUN_ACCESS_KEY_SECRET: 'test-access-key-secret',
    ALIYUN_SMS_SIGN_NAME: 'Test Sign',
    ALIYUN_SMS_TEMPLATE_CODE: 'SMS_TEST_CODE',
    ALIYUN_SMS_TEMPLATE_PARAM: '{"code":"##code##"}',
  };
  smsMocks.configs.length = 0;
  smsMocks.send.mockReset();
  smsMocks.check.mockReset();
});

describe('阿里云 Dypnsapi 短信验证码', () => {
  it('以管理员配置调用发送接口，并禁止返回明文验证码', async () => {
    smsMocks.send.mockResolvedValue({ body: { success: true, code: 'OK' } });

    await sendAliyunSmsVerifyCode('13812345678');

    expect(smsMocks.configs[0]).toMatchObject({
      accessKeyId: 'test-access-key-id',
      accessKeySecret: 'test-access-key-secret',
      endpoint: 'dypnsapi.aliyuncs.com',
    });
    expect(smsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
      phoneNumber: '13812345678',
      countryCode: '86',
      signName: 'Test Sign',
      templateCode: 'SMS_TEST_CODE',
      templateParam: '{"code":"##code##"}',
      codeLength: 6,
      validTime: 300,
      returnVerifyCode: false,
    }));
  });

  it('将阿里云 PASS / UNKNOWN 结果映射为验证码通过 / 不匹配', async () => {
    smsMocks.check
      .mockResolvedValueOnce({ body: { success: true, code: 'OK', model: { verifyResult: 'PASS' } } })
      .mockResolvedValueOnce({ body: { success: true, code: 'OK', model: { verifyResult: 'UNKNOWN' } } });

    await expect(checkAliyunSmsVerifyCode('13812345678', '123456')).resolves.toBe(true);
    await expect(checkAliyunSmsVerifyCode('13812345678', '000000')).resolves.toBe(false);
    expect(smsMocks.check).toHaveBeenCalledWith(expect.objectContaining({
      phoneNumber: '13812345678',
      countryCode: '86',
      verifyCode: '123456',
    }));
  });

  it('未配置凭据或阿里云返回失败时明确报错', async () => {
    smsMocks.settings.ALIYUN_ACCESS_KEY_SECRET = '';
    await expect(sendAliyunSmsVerifyCode('13812345678')).rejects.toThrow('AccessKey 未配置');
    expect(smsMocks.send).not.toHaveBeenCalled();

    smsMocks.settings.ALIYUN_ACCESS_KEY_SECRET = 'test-access-key-secret';
    smsMocks.send.mockResolvedValue({ body: { success: false, code: 'InvalidParameter' } });
    await expect(sendAliyunSmsVerifyCode('13812345678')).rejects.toThrow('阿里云短信发送失败: InvalidParameter');
  });
});
