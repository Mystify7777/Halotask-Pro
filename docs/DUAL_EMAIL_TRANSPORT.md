# Dual Email Transport: SMTP + Resend Fallback

## Overview

HaloTaskPro now supports dual email delivery for password reset codes:

1. **Primary:** SMTP (if configured) - Your own email server
2. **Secondary:** Resend (fallback) - Managed email service
3. **Fallback:** Server logs (if both unavailable)

This ensures robust email delivery with automatic failover.

## Transport Priority

```
┌─────────────────────────────┐
│   Email Send Request        │
└──────────────┬──────────────┘
               │
               ▼
         ┌─────────────┐
         │ SMTP        │ ◄─ Primary (if SMTP_* env vars set)
         │ Configured? │
         └──┬──────┬───┘
            │ Yes  │ No
            │      │
      ┌─────▼─┐    │
      │ Send  │    │
      │ via   │    │
      │ SMTP  │    │
      └─┬──┬──┘    │
        │  │       │
   ┌────┘  └───┐   │
   │ Success  Failed
   │           │    │
┌──▼──┐        ▼    │
│ Log │   ┌─────────┐│
│ OK  │   │ Resend  ││
└─────┘   │ Avail?  ││
          └──┬─┬──┬─┘│
             │ │  └──┘
         Yes │ │ No
        ┌────▼─▼──────┐
        │ Send via     │
        │ Resend       │
        └┬──┬─────────┬┘
         │  │         │
    Success │      Failed
         │  │         │
      ┌──▼──▼──────┐
      │ Log Code   │
      │ to Logs    │
      │ (Demo Mode)│
      └────────────┘
```

## Configuration

### Option 1: SMTP Only (Primary Transport)

Requires all four SMTP variables:

```bash
# .env or .env.production
SMTP_HOST=smtp.gmail.com          # Gmail, Outlook, SendGrid, etc.
SMTP_PORT=587                      # 587 for StartTLS, 465 for TLS
SMTP_USER=your-email@gmail.com    # SMTP user account
SMTP_PASS=your-app-password       # App password (not regular password)
EMAIL_FROM=HaloTaskPro <no-reply@yourdomain.com>
```

**No Resend API key needed** - SMTP will be primary, no fallback.

### Option 2: Resend Only (Current Setup)

Only requires Resend variables:

```bash
# .env or .env.production
RESEND_API_KEY=re_xxxxxxxxxxxxxx
EMAIL_FROM=HaloTaskPro <no-reply@yourdomain.com>
# SMTP_* variables not set (or empty)
```

**No SMTP configured** - Resend is primary, logs as fallback.

### Option 3: Dual Transport (Both SMTP + Resend)

Configure both for maximum reliability:

```bash
# .env or .env.production
# SMTP (Primary)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password

# Resend (Fallback)
RESEND_API_KEY=re_xxxxxxxxxxxxxx
EMAIL_FROM=HaloTaskPro <no-reply@yourdomain.com>
```

**SMTP tried first**, if fails → **Resend tried next**, if both fail → **Logs code**.

### Option 4: Demo Mode (No Email)

Don't configure any email variables:

```bash
# SMTP_* variables not set
# RESEND_API_KEY not set
# Codes logged to server logs only
```

**All codes logged to server logs** - Use for development/testing.

## SMTP Provider Setup

### Gmail

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=<16-character app password from https://myaccount.google.com/apppasswords>
```

**Steps:**
1. Enable 2FA on Google Account
2. Go to https://myaccount.google.com/apppasswords
3. Create app password for "Mail" + "Windows (or other)"
4. Copy 16-char password (remove spaces)

### Outlook / Office 365

```bash
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_USER=your-email@outlook.com
SMTP_PASS=your-password
```

### SendGrid

```bash
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=SG.xxxxxxxxxxxxxxxxxxxxxx
```

### AWS SES

```bash
SMTP_HOST=email-smtp.us-east-1.amazonaws.com
SMTP_PORT=587
SMTP_USER=<SMTP username from SES>
SMTP_PASS=<SMTP password from SES>
```

### Custom SMTP Server

```bash
SMTP_HOST=mail.yourdomain.com
SMTP_PORT=587        # or 465 for TLS
SMTP_USER=your-user@yourdomain.com
SMTP_PASS=your-password
```

## Server Logs: Reading Delivery Status

### Log Entries Explained

**SMTP Success:**
```
[Auth] Email delivered via SMTP for us***@example.com. Message ID: <msg123@server>
[Auth] Provider: SMTP | Status: SUCCESS | Email: us***@example.com
```

**SMTP Failed → Resend Success:**
```
[Auth] SMTP delivery failed for us***@example.com. Error: Connection timeout
[Auth] Provider: SMTP | Status: FAILED | Error: Connection timeout
[Auth] Email delivered via Resend for us***@example.com. ID: 01abc123def
[Auth] Provider: Resend | Status: SUCCESS | Email: us***@example.com
```

**Both Failed → Demo Mode:**
```
[Auth] SMTP delivery failed for us***@example.com. Error: Invalid credentials
[Auth] Provider: SMTP | Status: FAILED | Error: Invalid credentials
[Auth] Resend delivery failed for us***@example.com. Error: Unauthorized
[Auth] Provider: Resend | Status: FAILED | Error: Unauthorized
[Auth] Provider: DEMO_MODE | Status: LOGGED | Code for us***@example.com: 123456
```

**Demo Mode Only (No Transports):**
```
[Auth] No email transport configured (SMTP or Resend). Using demo mode.
[Auth] Provider: DEMO_MODE | Status: LOGGED | Code for us***@example.com: 123456
```

## Testing Delivery

### 1. Check Your Configuration

```bash
# Backend startup - look for these lines:
[Auth] SMTP configured: YES/NO
[Auth] Resend configured: YES/NO
```

### 2. Trigger Password Reset

```bash
# Test forgot-password endpoint
curl -X POST http://localhost:5000/api/auth/forgot-password \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}'
```

### 3. Read Server Logs

Watch backend server logs (Render, Railway, or local):

```
[Auth] Provider: SMTP | Status: SUCCESS | Email: te***@example.com
```

or

```
[Auth] Provider: Resend | Status: SUCCESS | Email: te***@example.com
```

or (demo mode)

```
[Auth] Provider: DEMO_MODE | Status: LOGGED | Code for te***@example.com: 123456
```

## Monitoring & Troubleshooting

### SMTP Issues

**"Connection timeout"**
- ❌ Host/port incorrect
- ✅ Verify SMTP_HOST and SMTP_PORT with provider
- ✅ Check firewall (port 587/465 open)

**"Invalid credentials"**
- ❌ SMTP_USER or SMTP_PASS incorrect
- ✅ Verify credentials with provider
- ✅ For Gmail: Use app password, not account password

**"Sender address rejected"**
- ❌ EMAIL_FROM not verified with provider
- ✅ Verify sender domain/email with SMTP provider

### Resend Issues

**"Unauthorized"**
- ❌ RESEND_API_KEY invalid or expired
- ✅ Check key at https://resend.com/api-keys
- ✅ Regenerate if needed

**"Domain not verified"**
- ❌ EMAIL_FROM domain not verified in Resend
- ✅ Verify domain in Resend dashboard

**"Domain not verified"** (from-email)
- ❌ sender email not verified
- ✅ Use Resend's default sender or verify domain

### Common Production Issues

**Both fail → Logs are only record**
- Users see: "If an account exists for this email, check your inbox..."
- Actual state: Code logged to server logs only
- Users cannot reset without checking logs (dev scenario)

**Solution:**
- Test email delivery in staging BEFORE production
- Verify SMTP credentials
- Verify Resend domain + sender
- Monitor logs after deployment

## Environment Variables Reference

```bash
# SMTP Configuration (Primary)
SMTP_HOST=              # SMTP server hostname
SMTP_PORT=587           # Default: 587 (StartTLS) or 465 (TLS)
SMTP_USER=              # SMTP user/email
SMTP_PASS=              # SMTP password or app password

# Resend Configuration (Secondary)
RESEND_API_KEY=         # Resend API key from dashboard
EMAIL_FROM=             # From address: "Company <email@domain.com>"

# Password Reset
RESET_TOKEN_TTL_MINUTES=20  # Code expiry time in minutes
```

## Deployment Checklist

- [ ] SMTP configured and tested (if using)
  - [ ] SMTP_HOST and SMTP_PORT correct
  - [ ] SMTP_USER and SMTP_PASS valid
  - [ ] EMAIL_FROM verified with SMTP provider
  
- [ ] Resend configured and tested (if using)
  - [ ] RESEND_API_KEY valid
  - [ ] EMAIL_FROM domain/sender verified in Resend
  
- [ ] Test email delivery in staging
  - [ ] Request password reset
  - [ ] Check server logs for delivery status
  - [ ] Verify email received (or code in logs)
  
- [ ] Monitor production logs
  - [ ] Watch for delivery failures
  - [ ] Alert on DEMO_MODE status
  - [ ] Track which provider is being used
  
- [ ] Failover tested
  - [ ] Disable SMTP (remove env vars)
  - [ ] Verify Resend takes over
  - [ ] Re-enable SMTP

## Production Best Practices

1. **Use SMTP for critical infrastructure**
   - Self-owned email server = independent from external services
   - Lower latency (usually)
   - No API quotas

2. **Use Resend as proven fallback**
   - Reliable managed service
   - Simple API
   - Handles abuse prevention

3. **Monitor both transports**
   - Set up log aggregation (Render, Railway logs)
   - Alert on FAILED status
   - Track SUCCESS → FAILED transitions

4. **Test regularly**
   - Weekly: Manually trigger password reset
   - Verify logs show correct provider
   - Check email arrives (if configured)

5. **Have a runbook**
   - If emails stop arriving:
     1. Check logs for FAILED status
     2. Verify SMTP/Resend credentials
     3. Update env variables on platform
     4. Redeploy
     5. Test password reset again

## Security Notes

- 🔒 SMTP passwords stored in env variables (not in code)
- 🔒 Resend API keys stored in env variables (not in code)
- 🔒 Email addresses masked in logs: `us***@example.com`
- 🔒 Reset codes never logged in plaintext (hashed in DB)
- ⚠️ Server logs may contain codes in demo mode (clear before production)

## Example: Full Production Setup

```bash
# .env.production
PORT=5000

# Database
MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/halotasks
MONGO_DNS_SERVERS=8.8.8.8,1.1.1.1

# Auth
JWT_SECRET=<strong-random-64-char-value>
CLIENT_ORIGIN=https://halotask-pro.vercel.app
APP_BASE_URL=https://halotask-pro.vercel.app

# Email (SMTP Primary + Resend Fallback)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=noreply@halotasks.com
SMTP_PASS=<16-char app password>
RESEND_API_KEY=re_xxxxxxxxxxxxx
EMAIL_FROM=HaloTaskPro <noreply@halotasks.com>

# Password Reset
RESET_TOKEN_TTL_MINUTES=15
```

Then deploy to Render/Railway with these env vars set.
