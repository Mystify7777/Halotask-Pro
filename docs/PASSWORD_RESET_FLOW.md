# Token-Based Password Reset Flow

## Overview

HaloTaskPro implements a secure 2-step token-based password reset flow where users request a reset code and then manually enter it (instead of using auto-populated URL links). This improves security and UX.

## Architecture

### Token Generation & Storage

**Backend generates 6-digit numeric code:**
```
Format: 000000 - 999999
Storage: SHA-256 hash of code in DB
TTL: 15 minutes (configurable via RESET_TOKEN_TTL_MINUTES env var)
Single-use: Cleared after successful reset
```

### Rate Limiting

**IP-based rate limiting on forgot-password endpoint:**
```
Limit: 5 attempts per 15 minutes per IP
Applied at: /api/auth/forgot-password
Returns: 429 Too Many Requests if exceeded
```

### Security Features

- **Neutral response**: Always returns same message whether email exists or not (prevents email enumeration)
- **Token hashing**: Code is never stored in plaintext; only hash is stored
- **Expiry validation**: Token must be used within TTL or becomes invalid
- **Single-use**: Token cleared after reset, cannot be reused
- **Secure comparison**: Uses hash matching with time-constant comparison
- **Fallback logging**: If email delivery fails, code is logged to server logs for debugging

## API Endpoints

### 1. Request Reset Code

**Endpoint:** `POST /api/auth/forgot-password`

**Request:**
```json
{
  "email": "user@example.com"
}
```

**Response (200):**
```json
{
  "message": "If an account exists for this email, check your inbox for a reset code (or your spam folder). The code expires in 15 minutes."
}
```

**Error Responses:**
- `400 Bad Request`: Missing email field
- `429 Too Many Requests`: Rate limit exceeded

### 2. Reset Password with Code

**Endpoint:** `POST /api/auth/reset-password`

**Request:**
```json
{
  "email": "user@example.com",
  "token": "123456",
  "password": "newSecurePassword123"
}
```

**Response (200):**
```json
{
  "message": "Password updated. Please log in."
}
```

**Error Responses:**
- `400 Bad Request`: Missing fields or invalid password length
- `400 Bad Request`: Reset code is invalid or expired

## Frontend Flow

### Step 1: Request Code (ForgotPasswordPage)

```
User opens: /forgot-password
↓
Enters email
↓
Clicks "Send Reset Code"
↓
Receives: "If an account exists for this email, check your inbox..."
↓
User checks email for 6-digit code
```

### Step 2: Reset Password (ResetPasswordPage)

```
User opens: /reset-password
↓
Enters:
  - Email (matching the one reset was requested for)
  - Reset code (from email, 6 digits)
  - New password
  - Confirm password
↓
Clicks "Reset Password"
↓
Backend validates email + code + expiry
↓
Password updated → Redirects to /login
```

## Email Format

### Subject
```
Reset your HaloTaskPro password
```

### Plain Text
```
We received a request to reset your password.

Use the code below. It expires in 15 minutes.

Code: 123456

If you didn't request this, you can ignore this email.
```

### HTML (with styling)
```
Large 24px bold code displayed in brand color (#0f4db2)
```

## Fallback Behavior

**If Resend email service is unavailable:**

1. Code is still generated and stored in DB with hash
2. Email send attempt fails (logged as error)
3. Code is printed to server logs with masked email:
   ```
   [Auth] FALLBACK - Reset code for us***@example.com: 123456
   ```
4. User can:
   - Check server logs (development/testing)
   - Contact support (production)

## Comparison: URL-Based vs Token-Based

| Aspect | URL-Based (Old) | Token-Based (New) |
|--------|-----------------|-------------------|
| **Token Format** | 64-char hex | 6-digit code |
| **Delivery** | URL link in email | Code in email body |
| **User Action** | Click link | Type/paste code |
| **Security** | Can appear in browser history | Not in URLs/history |
| **Accessibility** | Single click | Manual entry (more effort) |
| **Phishing Risk** | Malicious URLs possible | Still possible (email) |
| **Expiry** | 20 minutes | 15 minutes |

## Environment Variables

```bash
# .env or .env.production
RESET_TOKEN_TTL_MINUTES=15          # Token expiry in minutes
FORGOT_PASSWORD_WINDOW_MS=900000    # 15 minutes, rate limit window
FORGOT_PASSWORD_MAX_ATTEMPTS=5      # Max attempts per IP
EMAIL_FROM=noreply@yourdomain.com   # Verified Resend sender
RESEND_API_KEY=re_xxxxx             # Resend API credentials
```

## Testing

### Manual Testing Checklist

- [ ] Forgot password accepts email and returns neutral message
- [ ] Rate limiting: 6th attempt within 15 min returns 429
- [ ] Check server logs for code if email fails
- [ ] Reset password accepts email + code + password
- [ ] Reset with wrong code returns "invalid or expired"
- [ ] Reset with expired code returns "invalid or expired"
- [ ] After reset, old token cannot be reused
- [ ] User redirects to login after successful reset
- [ ] Can login with new password

### Automated Testing

```typescript
// Example test cases
test('Forgot password generates 6-digit code', async () => {
  const response = await api.post('/api/auth/forgot-password', {
    email: 'test@example.com',
  });
  expect(response.status).toBe(200);
  // Check server logs for code
});

test('Reset password requires email, token, and new password', async () => {
  const response = await api.post('/api/auth/reset-password', {
    email: 'test@example.com',
    token: '123456',
    password: 'newPassword123',
  });
  expect(response.status).toBe(200);
});
```

## Troubleshooting

### Emails Not Arriving

1. **Check server logs for code** (indicates email service failure)
   ```
   [Auth] FALLBACK - Reset code for us***@example.com: 123456
   ```

2. **Verify EMAIL_FROM is registered in Resend**
   - Go to Resend dashboard
   - Check if sender domain is verified
   - Consider using Resend's default sender if domain not verified

3. **Check Render/Railway logs for Resend errors**
   ```
   [Auth] Failed to send password reset email for us***@example.com. Resend error: ...
   ```

4. **Test with a new API key**
   - Regenerate RESEND_API_KEY if credentials exposed
   - Update Render/Railway env variables
   - Redeploy

### Code Expires Too Quickly

- Check `RESET_TOKEN_TTL_MINUTES` env var (default: 15 min)
- Verify server clock is synchronized
- Check if code was used in previous attempt (cleared after success)

### "Reset code is invalid or expired"

**Possible causes:**
1. Code typed incorrectly → User should check email again
2. Code has expired → Request new reset code
3. Code was already used → Request new reset code
4. Email doesn't match account → Use correct email

## Production Deployment Checklist

- [ ] RESET_TOKEN_TTL_MINUTES set appropriately (15-20 min recommended)
- [ ] EMAIL_FROM is verified sender in Resend
- [ ] RESEND_API_KEY is active and has sufficient quota
- [ ] Rate limiting is enabled (FORGOT_PASSWORD_MAX_ATTEMPTS=5)
- [ ] Server logs are accessible for debugging
- [ ] Frontend routes configured (/forgot-password, /reset-password)
- [ ] CORS configured to allow frontend origin
- [ ] Error messages are non-revealing (neutral responses)
- [ ] Tests pass end-to-end in staging

## Future Enhancements

- [ ] Add SMS-based code delivery option
- [ ] Add biometric/security key as alternative
- [ ] Add code resend (with cooldown)
- [ ] Add security questions as secondary verification
- [ ] Add login device confirmation
- [ ] Add password strength requirements indicator
- [ ] Add "reset password initiated" notifications to all user devices
