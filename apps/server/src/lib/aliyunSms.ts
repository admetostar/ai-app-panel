import DypnsapiModule, { CheckSmsVerifyCodeRequest, SendSmsVerifyCodeRequest } from '@alicloud/dypnsapi20170525';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import { getSetting } from './settings.js';

const Dypnsapi = DypnsapiModule.default;
type DypnsapiClient = InstanceType<typeof Dypnsapi>;

export function aliyunSmsConfigured(): boolean {
  return [
    'ALIYUN_ACCESS_KEY_ID',
    'ALIYUN_ACCESS_KEY_SECRET',
    'ALIYUN_SMS_SIGN_NAME',
    'ALIYUN_SMS_TEMPLATE_CODE',
    'ALIYUN_SMS_TEMPLATE_PARAM',
  ].every((key) => Boolean(getSetting(key)?.trim()));
}

function createClient(): DypnsapiClient {
  const accessKeyId = getSetting('ALIYUN_ACCESS_KEY_ID')?.trim();
  const accessKeySecret = getSetting('ALIYUN_ACCESS_KEY_SECRET')?.trim();
  if (!accessKeyId || !accessKeySecret) {
    throw new Error('阿里云短信 AccessKey 未配置');
  }

  return new Dypnsapi(new $OpenApiUtil.Config({
    accessKeyId,
    accessKeySecret,
    endpoint: 'dypnsapi.aliyuncs.com',
    regionId: 'cn-hangzhou',
  }));
}

function requiredSetting(key: string): string {
  const value = getSetting(key)?.trim();
  if (!value) throw new Error(`阿里云短信配置缺失：${key}`);
  return value;
}

export async function sendAliyunSmsVerifyCode(phoneNumber: string): Promise<void> {
  const client = createClient();
  const response = await client.sendSmsVerifyCode(new SendSmsVerifyCodeRequest({
    phoneNumber,
    countryCode: '86',
    signName: requiredSetting('ALIYUN_SMS_SIGN_NAME'),
    templateCode: requiredSetting('ALIYUN_SMS_TEMPLATE_CODE'),
    templateParam: requiredSetting('ALIYUN_SMS_TEMPLATE_PARAM'),
    codeLength: 6,
    codeType: 1,
    validTime: 300,
    interval: 60,
    duplicatePolicy: 1,
    returnVerifyCode: false,
    schemeName: getSetting('ALIYUN_SMS_SCHEME_NAME')?.trim() || undefined,
  }));
  const body = response.body;
  if (body?.success !== true || body.code !== 'OK') {
    throw new Error(`阿里云短信发送失败: ${body?.code ?? 'UNKNOWN'}`);
  }
}

export async function checkAliyunSmsVerifyCode(phoneNumber: string, verifyCode: string): Promise<boolean> {
  const response = await createClient().checkSmsVerifyCode(new CheckSmsVerifyCodeRequest({
    phoneNumber,
    countryCode: '86',
    verifyCode,
    schemeName: getSetting('ALIYUN_SMS_SCHEME_NAME')?.trim() || undefined,
  }));
  const body = response.body;
  if (body?.success !== true || body.code !== 'OK') {
    throw new Error(`阿里云短信验证码校验失败: ${body?.code ?? 'UNKNOWN'}`);
  }
  return body.model?.verifyResult === 'PASS';
}
