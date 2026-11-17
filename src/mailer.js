import nodemailer from 'nodemailer';

export function createMailer(env = process.env, logger = console) {
  const configured = env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASSWORD;
  if (env.NODE_ENV === 'production' && !configured) throw new Error('SMTP_HOST, SMTP_USER, and SMTP_PASSWORD are required in production');
  const transport = configured ? nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    secure: Number(env.SMTP_PORT || 587) === 465,
    connectionTimeout: 60_000,
    greetingTimeout: 60_000,
    socketTimeout: 60_000,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD }
  }) : null;
  return {
    mode: configured ? 'smtp' : 'demo',
    async send({ to, subject, text }) {
      if (!transport) {
        logger.log(`FreshOut demo email\nTo: ${to}\nSubject: ${subject}\n\n${text}`);
        return;
      }
      await transport.sendMail({ from: env.EMAIL_FROM || env.SMTP_USER, to, subject, text });
    }
  };
}
