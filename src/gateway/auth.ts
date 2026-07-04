/**
 * 认证模块 —— 配对码 + device token 两步握手
 *
 * 流程：
 * 1. Gateway 启动生成 6 位配对码，显示在终端
 * 2. 手机端首次 connect 带配对码 → 验证 → 返回 device token
 * 3. 后续 connect 带 device token → 直接通过
 *
 * 支持 GATEWAY_TOKEN 环境变量（固定 token 模式，跳过配对）。
 * localhost 免认证（开发模式）。
 */

import { customAlphabet } from "nanoid";

const generateToken = customAlphabet(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  32,
);

// 6 位数字配对码，易输入
function generatePairingCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += Math.floor(Math.random() * 10);
  }
  return code;
}

export class AuthManager {
  private pairingCode: string;
  private deviceTokens = new Set<string>();
  private envToken: string | null;

  constructor() {
    this.pairingCode = generatePairingCode();
    this.envToken = process.env.GATEWAY_TOKEN ?? null;
  }

  /** 配对码展示（终端显示给用户） */
  get pairingCodeDisplay(): string {
    return this.pairingCode;
  }

  /** 是否设置了环境变量 token */
  hasEnvToken(): boolean {
    return this.envToken !== null;
  }

  /**
   * 验证配对码，通过后颁发 device token
   * @returns device token（成功）或 null（失败）
   */
  pair(code: string): string | null {
    if (code !== this.pairingCode) return null;
    const token = generateToken();
    this.deviceTokens.add(token);
    return token;
  }

  /** 验证 device token 或环境变量 token */
  verify(token: string | undefined): boolean {
    if (!token) return false;
    // 环境变量 token
    if (this.envToken && token === this.envToken) return true;
    // device token
    return this.deviceTokens.has(token);
  }

  /** 撤销 device token */
  revoke(token: string): void {
    this.deviceTokens.delete(token);
  }
}
