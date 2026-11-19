import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

const originalEnv = { ...process.env };

const resetEnv = (): void => {
  process.env = { ...originalEnv };
};

describe('Email transport configuration', () => {
  beforeEach(() => {
    resetEnv();
    vi.resetModules();
  });

  afterEach(() => {
    resetEnv();
  });

  it('should fail gracefully in production without SMTP configuration', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PUBLIC_URL = 'https://example.com';

    const { sendVerificationEmail } = await import('../src/email');
    const result = await sendVerificationEmail('user@test.com', 'token');
    expect(result).toBe(false);
  });

  it('sends the verification code and its expiry without exposing vault secrets', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PUBLIC_URL = 'https://example.com';
    process.env.SMTP_HOST = 'smtp.example.com';
    const sendMail = vi.fn().mockResolvedValue({});
    vi.doMock('nodemailer', () => ({ createTransport: () => ({ sendMail }) }));
    try {
      const { sendUltraAccountEmail } = await import('../src/email');
      expect(await sendUltraAccountEmail('user@example.com', 'verify', '01234567')).toBe(
        true,
      );
      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@example.com',
          text: expect.stringContaining('01234567'),
        }),
      );
      const text = sendMail.mock.calls[0][0].text as string;
      expect(text).toContain('30 minutes');
      expect(text).not.toContain('?verify=');
    } finally {
      vi.doUnmock('nodemailer');
    }
  });

  it('describes every account email as an Ultra Tasks account message', async () => {
    const { ultraAccountMail } = await import('../src/email');
    const verify = ultraAccountMail(
      'verify',
      '01234567',
      'https://accounts.example.test',
    );
    const link = ultraAccountMail(
      'verify',
      'a'.repeat(43),
      'https://accounts.example.test',
    );
    const recover = ultraAccountMail(
      'recover',
      'b'.repeat(43),
      'https://accounts.example.test',
    );
    for (const message of [
      verify,
      link,
      recover,
      ultraAccountMail('device', '12345678', 'x'),
    ]) {
      expect(`${message.subject} ${message.text}`).toContain('Ultra Tasks account');
      expect(`${message.subject} ${message.text}`).not.toMatch(
        /UltraSync|UltraTasks|SuperSync/,
      );
    }
    expect(verify.subject).toBe('Verify your Ultra Tasks account');
    expect(recover.subject).toBe('Recover your Ultra Tasks account');
  });

  it('sends the new-device code with its expiry and nothing a caller controls', async () => {
    const { ultraAccountMail } = await import('../src/email');
    const message = ultraAccountMail(
      'device',
      '12345678',
      'https://accounts.example.test',
    );
    expect(message.subject).toBe('Your Ultra Tasks account verification code');
    expect(message.text).toContain('12345678');
    expect(message.text).toContain('10 minutes');
    expect(message.text).toContain('ignore this email');
    // No link (the code is typed where the person is signing in), no host name, no secret handle.
    expect(message.text).not.toMatch(/https?:|\?|accounts\.example\.test/);
    // Only an eight-digit code is ever mailed under this kind.
    for (const bad of ['1234567', '123456789', 'abcdefgh', '1234 5678', 'a'.repeat(43)])
      expect(() =>
        ultraAccountMail('device', bad, 'https://accounts.example.test'),
      ).toThrow();
  });

  it('delivers the new-device code and never logs it, even when delivery fails', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PUBLIC_URL = 'https://example.com';
    process.env.SMTP_HOST = 'smtp.example.com';
    const sendMail = vi.fn().mockResolvedValue({});
    vi.doMock('nodemailer', () => ({ createTransport: () => ({ sendMail }) }));
    try {
      const { sendUltraAccountEmail } = await import('../src/email');
      const { Logger } = await import('../src/logger');
      const logged = [
        vi.spyOn(Logger, 'info'),
        vi.spyOn(Logger, 'warn'),
        vi.spyOn(Logger, 'error'),
      ];
      expect(await sendUltraAccountEmail('user@example.com', 'device', '87654321')).toBe(
        true,
      );
      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@example.com',
          subject: 'Your Ultra Tasks account verification code',
          text: expect.stringContaining('87654321'),
        }),
      );
      sendMail.mockRejectedValueOnce(new Error('connection refused for 87654321'));
      expect(await sendUltraAccountEmail('user@example.com', 'device', '87654321')).toBe(
        false,
      );
      expect(
        await sendUltraAccountEmail('user@example.com', 'device', 'not-a-code'),
      ).toBe(false);
      expect(JSON.stringify(logged.map((spy) => spy.mock.calls))).not.toContain(
        '87654321',
      );
    } finally {
      vi.doUnmock('nodemailer');
      vi.restoreAllMocks();
    }
  });
});
