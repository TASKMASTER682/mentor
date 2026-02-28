import { Resend } from 'resend';

let resendClient = null;

const getResendClient = () => {
  if (resendClient) return resendClient;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is missing in environment variables.');
  }

  resendClient = new Resend(apiKey);
  return resendClient;
};

export const emailService = {
  async sendVerificationEmail({ toEmail, name, verificationLink }) {
    const resend = getResendClient();
    const isTestMode = String(process.env.RESEND_TEST_MODE || '').toLowerCase() === 'true';
    const configuredFrom = isTestMode
      ? 'UPSC-POS <onboarding@resend.dev>'
      : (process.env.RESEND_FROM || 'UPSC-POS <onboarding@resend.dev>');
    const fallbackFrom = 'UPSC-POS <onboarding@resend.dev>';

    const subject = 'Verify your UPSC-POS account';
    const text = [
      `Hi ${name},`,
      '',
      'Welcome to UPSC-POS.',
      'Please verify your account using the link below:',
      verificationLink,
      '',
      'This link will expire in 24 hours.',
      '',
      'Stay disciplined,',
      'ARJUN | UPSC-POS',
    ].join('\n');

    const html = `
      <div style="margin:0;padding:0;background:#0b0b0d;font-family:Inter,Segoe UI,Arial,sans-serif;color:#f5f5f5;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b0d;padding:32px 12px;">
          <tr>
            <td align="center">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:linear-gradient(180deg,#131316 0%,#0f0f12 100%);border:1px solid #26262b;border-radius:16px;overflow:hidden;">
                <tr>
                  <td style="padding:24px 24px 12px 24px;">
                    <div style="font-size:11px;letter-spacing:1.8px;color:#ff9a3d;text-transform:uppercase;font-weight:700;">UPSC-POS</div>
                    <h1 style="margin:8px 0 0 0;font-size:24px;line-height:1.2;color:#ffffff;">Verify Your Account</h1>
                  </td>
                </tr>
                <tr>
                  <td style="padding:4px 24px 0 24px;">
                    <p style="margin:0 0 14px 0;color:#d2d2d7;font-size:14px;line-height:1.6;">
                      Hi ${name}, welcome to your UPSC preparation system.
                    </p>
                    <p style="margin:0 0 20px 0;color:#b5b5bd;font-size:14px;line-height:1.6;">
                      Confirm your email to activate your account and continue with ARJUN.
                    </p>
                    <a href="${verificationLink}" style="display:inline-block;background:#ff8a1f;color:#121212;text-decoration:none;font-weight:700;font-size:14px;padding:12px 18px;border-radius:10px;">
                      Verify Email
                    </a>
                    <p style="margin:20px 0 0 0;color:#8a8a95;font-size:12px;line-height:1.6;">
                      Link valid for 24 hours.
                    </p>
                    <p style="margin:10px 0 0 0;color:#8a8a95;font-size:12px;line-height:1.6;word-break:break-all;">
                      If button doesn't work, open this URL:<br/>${verificationLink}
                    </p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:20px 24px 24px 24px;">
                    <div style="height:1px;background:#25252b;margin-bottom:14px;"></div>
                    <p style="margin:0;color:#6f6f7a;font-size:11px;letter-spacing:0.3px;">
                      PROCESS OVER FANTASY • ARJUN | UPSC-POS
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </div>
    `;

    const sendWithFrom = async (fromAddress) => {
      const { error } = await resend.emails.send({
        from: fromAddress,
        to: toEmail,
        subject,
        text,
        html,
      });
      return error || null;
    };

    let error = await sendWithFrom(configuredFrom);
    const domainNotVerified = error?.message?.toLowerCase?.().includes('domain is not verified');

    if (error && domainNotVerified && configuredFrom !== fallbackFrom) {
      console.warn('Resend domain not verified for RESEND_FROM. Retrying with onboarding@resend.dev');
      error = await sendWithFrom(fallbackFrom);
    }

    if (error) {
      throw new Error(`Resend email error: ${error.message}`);
    }
  },
};
