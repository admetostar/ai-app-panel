/**
 * AWPK Python 包第三方依赖（声明制）：
 * manifest.requirements 声明 → 上传/更新时 pip 安装到 <appsites>/<id>/.deps →
 * 沙箱 env 注入 PYTHONPATH 前置。设计要点：
 *  - 只装 wheel（--only-binary=:all:）：安装期不执行 sdist setup.py 任意代码
 *  - 失败在上传口报错并清理，不带病上线（否则是线上 ModuleNotFoundError 静默 503）
 *  - .deps 在数据卷应用目录下：docker 重建 / 容器升级不丢
 *  - PIP_INDEX_URL（平台设置）支持国内镜像；代理 env 放行同 SANDBOX_ENV_KEYS
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { appSiteDir } from '../gateway/staticApp.js';
import { HttpError } from './httpError.js';
import { getSetting } from './settings.js';

export const PY_DEPS_DIRNAME = '.deps';
export const PIP_INSTALL_TIMEOUT_MS = 300_000;
const PIP_PROGRESS_LOG_INTERVAL_MS = 30_000;
const PIP_OUTPUT_TAIL_LENGTH = 4_000;

export function pyDepsDir(appId: string): string {
  return path.join(appSiteDir(appId), PY_DEPS_DIRNAME);
}

function pipEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME || '/tmp',
  };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  const index = getSetting('PIP_INDEX_URL')?.trim();
  if (index) {
    env.PIP_INDEX_URL = index;
    try {
      env.PIP_TRUSTED_HOST = new URL(index).host; // http 镜像源需要；https 时无害
    } catch {
      /* 非法 URL 交给 pip 自己报错 */
    }
  }
  return env;
}

/** 安装/刷新应用依赖。requirements 为空时清空 .deps：新版本不再声明的旧依赖不残留。 */
export async function installPyDeps(appId: string, requirements: string[]): Promise<void> {
  const dir = pyDepsDir(appId);
  fs.rmSync(dir, { recursive: true, force: true });
  if (!requirements.length) return;
  const reqFile = path.join(appSiteDir(appId), '.deps-requirements.txt');
  fs.mkdirSync(appSiteDir(appId), { recursive: true });
  fs.writeFileSync(reqFile, `${requirements.join('\n')}\n`);
  await runPip(appId, requirements, [
    '-m', 'pip', 'install',
    '--only-binary=:all:',
    '--no-compile',
    '--disable-pip-version-check',
    '--target', dir,
    '-r', reqFile,
  ]);
  fs.rmSync(reqFile, { force: true });
}

function runPip(appId: string, requirements: string[], args: string[]): Promise<void> {
  const pythonBin = process.env.PYTHON_BIN || 'python3';
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    console.info(`[packages] Python 依赖安装开始：${appId}（${requirements.join(', ')}）`);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(pythonBin, args, { env: pipEnv() });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[packages] Python 依赖安装无法启动：${appId}（0s）：${detail}`);
      reject(new HttpError(400, 'PIP_INSTALL_FAILED', `pip 启动失败（PYTHON_BIN=${pythonBin}）：${detail}`));
      return;
    }
    let output = '';
    let settled = false;
    let timedOut = false;
    const appendOutput = (data: Buffer): void => {
      output = `${output}${data.toString()}`.slice(-PIP_OUTPUT_TAIL_LENGTH);
    };
    const sanitizedOutput = (): string => output
      .trim()
      .replace(/https?:\/\/\S+/gi, '[URL]')
      .replace(/(password|token|key)=\S+/gi, '$1=[REDACTED]')
      .split('\n')
      .slice(-8)
      .join('\n');
    const elapsedSeconds = (): number => Math.floor((Date.now() - startedAt) / 1000);
    const progressTimer = setInterval(() => {
      console.info(`[packages] Python 依赖安装仍在进行：${appId}（${elapsedSeconds()}s）`);
    }, PIP_PROGRESS_LOG_INTERVAL_MS);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      const tail = sanitizedOutput();
      const message = `依赖安装超时（>${PIP_INSTALL_TIMEOUT_MS / 1000}s），请检查容器到 pip 索引源的网络或 PIP_INDEX_URL${tail ? `：\n${tail}` : ''}`;
      console.error(`[packages] Python 依赖安装超时：${appId}（${elapsedSeconds()}s）${tail ? `\n${tail}` : ''}`);
      settled = true;
      clearInterval(progressTimer);
      reject(new HttpError(504, 'PIP_TIMEOUT', message));
    }, PIP_INSTALL_TIMEOUT_MS);
    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(progressTimer);
      console.error(`[packages] Python 依赖安装无法启动：${appId}（${elapsedSeconds()}s）：${err.message}`);
      reject(new HttpError(400, 'PIP_INSTALL_FAILED', `pip 启动失败（PYTHON_BIN=${pythonBin}）：${err.message}`));
    });
    child.on('close', (code, signal) => {
      if (settled || timedOut) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(progressTimer);
      const elapsed = elapsedSeconds();
      if (code === 0) {
        console.info(`[packages] Python 依赖安装完成：${appId}（${elapsed}s）`);
        resolve();
        return;
      }
      const tail = sanitizedOutput();
      const message = `依赖安装失败（exit ${code ?? signal ?? 'unknown'}）：\n${tail}`;
      console.error(`[packages] Python 依赖安装失败：${appId}（${elapsed}s，exit ${code ?? signal ?? 'unknown'}）${tail ? `\n${tail}` : ''}`);
      reject(new HttpError(400, 'PIP_INSTALL_FAILED', message));
    });
  });
}
