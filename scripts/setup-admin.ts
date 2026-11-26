/**
 * Generates the admin password hash, TOTP secret and session secret for R13.
 *   npm run setup:admin
 * Scan the otpauth link (or paste the secret) into an authenticator app shared by the founders.
 */
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { authenticator } from 'otplib';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const email = (await rl.question('Admin email [admin@complao.com]: ')).trim() || 'admin@complao.com';
const password = await rl.question('Choose a password (14+ characters): ');
rl.close();
if (password.length < 14) {
  console.error('Use at least 14 characters.');
  process.exit(1);
}

const secret = authenticator.generateSecret(20);
const hash = await bcrypt.hash(password, 12);
console.log(`
Add these to the API environment (Secrets Manager / SSM in AWS, .env locally):

ADMIN_EMAIL=${email}
ADMIN_PASSWORD_HASH='${hash}'
ADMIN_TOTP_SECRET=${secret}
SESSION_SECRET=${randomBytes(32).toString('base64url')}

Authenticator setup link (open on a phone or turn into a QR code):
${authenticator.keyuri(email, 'Complao action log', secret)}
`);
