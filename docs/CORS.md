# CORS Configuration Reference

## Overview

CORS (Cross-Origin Resource Sharing) is a security feature that controls which domains can call your API. HaloTaskPro uses CORS to ensure only your frontend can access your backend.

## Current Configuration

Backend CORS is configured in `halotasks-server/src/app.ts`:

```typescript
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN ?? true,
    credentials: true,
  }),
);
```

## Environment Variables

### Backend: CLIENT_ORIGIN

Controls which frontend domain(s) can access the API.

**Local Development:**
```
CLIENT_ORIGIN=http://localhost:5173
```

**Production (Single Domain):**
```
CLIENT_ORIGIN=https://yourdomain.com
```

**Important Rules:**
- Must be exact domain match (case-sensitive)
- Include protocol (http:// or https://)
- No trailing slash
- No wildcard (*) in production
- One domain per environment variable currently

### Frontend: VITE_API_BASE_URL

Tells frontend where to send API requests.

**Local Development:**
```
VITE_API_BASE_URL=http://localhost:5000
```

**Production:**
```
VITE_API_BASE_URL=https://your-api-domain.com
```

**Important Rules:**
- Must match backend domain/port
- Include protocol (http:// or https://)
- No trailing slash
- Must be accessible from client browser

## Common CORS Scenarios

### Scenario 1: Frontend and Backend on Same Domain

```
Frontend: https://yourdomain.com
Backend: https://yourdomain.com/api

Frontend .env:
VITE_API_BASE_URL=https://yourdomain.com/api

Backend .env:
CLIENT_ORIGIN=https://yourdomain.com
```

**Setup:** Use reverse proxy (Nginx, Apache) to route `/api/*` to backend server.

### Scenario 2: Frontend and Backend on Different Subdomains

```
Frontend: https://app.yourdomain.com
Backend: https://api.yourdomain.com

Frontend .env:
VITE_API_BASE_URL=https://api.yourdomain.com

Backend .env:
CLIENT_ORIGIN=https://app.yourdomain.com
```

### Scenario 3: Frontend on CDN, Backend on Server

```
Frontend: https://cdn.yourdomain.com or https://yourdomain.com (via CDN)
Backend: https://api.yourdomain.com

Frontend .env:
VITE_API_BASE_URL=https://api.yourdomain.com

Backend .env:
CLIENT_ORIGIN=https://yourdomain.com  (or whatever CDN serves as)
```

## Testing CORS

### Browser Test

1. Open frontend in browser
2. Open Developer Tools (F12)
3. Go to Network tab
4. Perform login/register action
5. Check request headers:
   - Request should include `Origin: https://yourdomain.com`
   - Response should include `Access-Control-Allow-Origin: https://yourdomain.com`
   - Response should include `Access-Control-Allow-Credentials: true`

### Command-line Test

```bash
# Test without credentials
curl -H "Origin: https://yourdomain.com" \
     -H "Access-Control-Request-Method: POST" \
     -H "Access-Control-Request-Headers: Content-Type" \
     -X OPTIONS \
     https://api.yourdomain.com/api/auth/login -v

# Should see:
# Access-Control-Allow-Origin: https://yourdomain.com
# Access-Control-Allow-Credentials: true
```

## Troubleshooting CORS Errors

### Error: "No 'Access-Control-Allow-Origin' header is present"

**Cause:** Backend doesn't recognize frontend domain.

**Fix:**
1. Check `CLIENT_ORIGIN` exactly matches frontend domain
2. Check frontend domain case (CORS is case-sensitive)
3. Check frontend includes protocol (http:// or https://)
4. Restart backend after updating .env

**Debug:**
```bash
# What domain is the request coming from?
curl -H "Origin: https://yourdomain.com" -I https://api.yourdomain.com/
# Check for Access-Control-Allow-Origin in response
```

### Error: "The CORS protocol does not allow specifying a wildcard"

**Cause:** You tried to set `CLIENT_ORIGIN=*` in production.

**Fix:** Use exact domain instead:
```
CLIENT_ORIGIN=https://yourdomain.com
```

**Note:** Wildcard is only allowed in development (when CLIENT_ORIGIN is not set).

### Error: "Credentials mode is 'include' but Access-Control-Allow-Credentials is missing"

**Expected:** This is normal - backend sends proper headers.

**Fix:** Check network tab in browser for actual error underneath this warning.

### Mixed Content Error: "Blocked by CORS policy: The value of the 'Access-Control-Allow-Origin' header"

**Cause:** Frontend is HTTPS but backend is HTTP (or vice versa).

**Fix:** Both must use same protocol:
- Use HTTPS for both in production
- Can use HTTP://localhost for local development

## Security Best Practices

1. **Never use wildcard in production**: 
   ```
   ✗ CLIENT_ORIGIN=*
   ✓ CLIENT_ORIGIN=https://yourdomain.com
   ```

2. **Always match protocol**:
   ```
   ✗ Frontend: https://yourdomain.com, Backend: http://yourdomain.com
   ✓ Frontend: https://yourdomain.com, Backend: https://yourdomain.com
   ```

3. **Rotate domains carefully**:
   - Update frontend .env first
   - Verify frontend builds
   - Update backend .env
   - Restart backend
   - Test requests

4. **Test before promoting to production**:
   - Test on staging environment first
   - Verify both frontend and backend connect
   - Check logs for CORS errors

## Multiple Domains (Future)

Currently, `CLIENT_ORIGIN` supports one domain per environment. For multiple domains (e.g., production and staging), consider:

**Option 1: Environment-based**
- Staging .env: `CLIENT_ORIGIN=https://staging.yourdomain.com`
- Production .env: `CLIENT_ORIGIN=https://yourdomain.com`

**Option 2: Custom CORS middleware**
Update `halotasks-server/src/app.ts`:
```typescript
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',');

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  }),
);
```

Then set:
```
ALLOWED_ORIGINS=https://yourdomain.com,https://staging.yourdomain.com
```

## References

- [MDN CORS Documentation](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS)
- [Express CORS Package](https://github.com/expressjs/cors)
- [OWASP CORS Best Practices](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Origin_Resource_Sharing_cheatsheet.html)
