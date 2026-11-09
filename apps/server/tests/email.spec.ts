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
      expect(text).toContain('24 hours');
      expect(text).not.toContain('?verify=');
    } finally {
      vi.doUnmock('nodemailer');
    }
  });
});
