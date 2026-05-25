#!/usr/bin/env node
/**
 * generate-vapid.js
 *
 * Run once to generate your VAPID key pair:
 *   cd halotasks-server
 *   node scripts/generate-vapid.js
 *
 * Then copy the output into:
 *   halotasks-server/.env  -> VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_CONTACT_EMAIL
 *   halotasks-client/.env  -> VITE_VAPID_PUBLIC_KEY
 */

const webpush = require('web-push');

const keys = webpush.generateVAPIDKeys();

console.log('\nVAPID keys generated. Add these to your .env files:\n');
console.log('halotasks-server/.env');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log('VAPID_CONTACT_EMAIL=your-email@example.com');
console.log('\nhalotasks-client/.env');
console.log(`VITE_VAPID_PUBLIC_KEY=${keys.publicKey}`);