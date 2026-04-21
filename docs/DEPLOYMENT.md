# HaloTasks Production Deployment Guide

## Overview

HaloTasks is a full-stack application with:
- **Frontend**: React + TypeScript + Vite (static SPA)
- **Backend**: Node.js + Express + TypeScript + MongoDB
- **Email**: Resend for password reset notifications

This guide covers deployment of both client and server to production.

---

## Prerequisites

Before deploying, ensure you have:

1. **MongoDB Atlas Cluster**
   - Create account at https://www.mongodb.com/cloud/atlas
   - Create a cluster and get connection string
   - Add your deployment server IP to IP whitelist

2. **Resend Account**
   - Create account at https://resend.com
   - Verify your sender domain or single sender email
   - Get API key from https://resend.com/api-keys

3. **Deployment Environments**
   - Backend server (Node.js 20+)
   - Frontend hosting (static file server or CDN)
   - Domain(s) and SSL certificates

---

## Backend Deployment

### Step 1: Prepare Environment

Copy the production template and fill in all values:

```bash
cp halotasks-server/.env.production halotasks-server/.env
```

Update the following in `.env`:

```env
# MongoDB Atlas connection string
MONGO_URI=mongodb+srv://username:password@cluster.mongodb.net/halotasks?appName=HaloTasks

# Strong random JWT secret (generate with: openssl rand -base64 32)
JWT_SECRET=your-secret-here

# Frontend domain(s) allowed to call this API
# Use exact domain for production (no wildcard)
CLIENT_ORIGIN=https://yourdomain.com

# Frontend base URL for password reset links
APP_BASE_URL=https://yourdomain.com

# Resend API key
RESEND_API_KEY=re_XXXXXXXXXXXXXXXXXXXXXXXXXX

# Verified sender email in Resend
EMAIL_FROM=noreply@yourdomain.com

# Token expiry (20 minutes recommended)
RESET_TOKEN_TTL_MINUTES=20
```

### Step 2: Build for Production

```bash
cd halotasks-server
npm install
npm run build
```

The build output is in `dist/` directory.

### Step 3: Deploy

#### Option A: Deploy to Node Hosting (Heroku, Railway, Render, etc.)

**Heroku Example:**

```bash
heroku create your-app-name
heroku config:set MONGO_URI="mongodb+srv://..."
heroku config:set JWT_SECRET="..."
heroku config:set CLIENT_ORIGIN="https://yourdomain.com"
heroku config:set APP_BASE_URL="https://yourdomain.com"
heroku config:set RESEND_API_KEY="re_..."
heroku config:set EMAIL_FROM="noreply@yourdomain.com"
git push heroku main
```

**Railway Example:**

1. Connect GitHub repository to Railway
2. Add plugins: Node.js runtime
3. Set environment variables in Railway dashboard
4. Deploy runs automatically on push

#### Option B: Deploy to VM/Docker

**Docker Example:**

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist ./dist
CMD ["node", "dist/server.js"]
```

**Run:**

```bash
docker build -t halotasks-backend .
docker run -p 5000:5000 --env-file .env halotasks-backend
```

### Step 4: Verify Backend

```bash
curl https://your-api-domain.com/
# Should respond: "HaloTasks API running"

# Test health check
curl https://your-api-domain.com/api/auth/health 2>/dev/null || echo "Health endpoint not implemented"
```

---

## Frontend Deployment

### Step 1: Prepare Environment

Copy the production template:

```bash
cp halotasks-client/.env.production halotasks-client/.env
```

Update the backend API URL:

```env
# Must match your deployed backend server
VITE_API_BASE_URL=https://your-api-domain.com
```

### Step 2: Build for Production

```bash
cd halotasks-client
npm install
npm run build
```

The build output is in `dist/` directory (optimized static files).

### Step 3: Deploy Static Files

#### Option A: Deploy to Static Hosting (Vercel, Netlify, etc.)

**Vercel Example:**

1. Push code to GitHub
2. Connect repository to Vercel
3. Set environment variable: `VITE_API_BASE_URL=https://your-api-domain.com`
4. Deploy runs automatically on push

**Netlify Example:**

1. Push code to GitHub
2. Connect repository to Netlify
3. Build command: `npm run build`
4. Publish directory: `dist`
5. Add environment variable: `VITE_API_BASE_URL=https://your-api-domain.com`
6. Deploy runs automatically on push

#### Option B: Deploy to Web Server

```bash
# Copy dist/ to your web server
scp -r halotasks-client/dist/* user@server:/var/www/halotasks/

# Nginx configuration example
server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    root /var/www/halotasks;
    index index.html;

    # SPA routing: send all routes to index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache static assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Don't cache index.html
    location = /index.html {
        expires 5m;
        add_header Cache-Control "public, must-revalidate";
    }
}
```

### Step 4: Verify Frontend

Visit `https://yourdomain.com` and test:
- [ ] Login page loads
- [ ] Can navigate to register
- [ ] Can navigate to forgot password
- [ ] API calls connect to correct backend

---

## CORS Configuration

Cross-Origin Resource Sharing (CORS) security is critical in production.

### Backend CORS Setup

The server is configured in `halotasks-server/src/app.ts`:

```typescript
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN ?? true,
    credentials: true,
  }),
);
```

**Production Requirements:**
- `CLIENT_ORIGIN` must be set to exact frontend domain
- Do NOT use wildcard (`*`) in production
- Do NOT use `true` (allow all) in production

**Example:**

```env
# Single domain
CLIENT_ORIGIN=https://yourdomain.com

# Multiple domains (requires custom CORS config - contact support)
# For now, pick primary domain or reverse-proxy both under single domain
```

### Common CORS Issues

**Error: "No 'Access-Control-Allow-Origin' header"**
- Check `CLIENT_ORIGIN` matches exact frontend URL
- Check frontend is using correct `VITE_API_BASE_URL`
- Ensure HTTPS vs HTTP matches exactly (no mixed)

**Error: "Credentials mode is 'include' but Access-Control-Allow-Credentials is missing"**
- This is expected and safe - backend sends it
- Check browser console for other errors

---

## Password Reset Email Configuration

### Dual Transport Setup (SMTP + Resend Fallback)

HaloTaskPro supports dual email transport for maximum reliability:

**Priority:**
1. SMTP (if configured) - Your own email server
2. Resend (fallback) - Managed email service
3. Server logs (final fallback) - For debugging

### Option A: SMTP Only (Recommended for Production)

Configure your email provider's SMTP settings in backend `.env`:

**Gmail Example:**
```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=<16-char app password from myaccount.google.com/apppasswords>
EMAIL_FROM=HaloTaskPro <noreply@yourdomain.com>
```

**Custom SMTP:**
```env
SMTP_HOST=mail.yourdomain.com
SMTP_PORT=587
SMTP_USER=noreply@yourdomain.com
SMTP_PASS=<password>
EMAIL_FROM=HaloTaskPro <noreply@yourdomain.com>
```

### Option B: Resend Only (Current Setup)

1. Go to https://resend.com/domains
2. Add your domain or use Resend subdomain
3. Verify domain ownership (DNS records)
4. Get API key from https://resend.com/api-keys
5. Add to backend `.env`:

```env
RESEND_API_KEY=re_XXXXXXXXXXXXXXXXXXXXXXXXXX
EMAIL_FROM=HaloTaskPro <noreply@yourdomain.com>
# Don't set SMTP_* variables
```

### Option C: Dual Transport (SMTP + Resend Fallback)

Configure both for maximum reliability:

```env
# SMTP (Primary)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=noreply@yourdomain.com
SMTP_PASS=<app-password>

# Resend (Fallback)
RESEND_API_KEY=re_XXXXXXXXXXXXXXXXXXXXXXXXXX
EMAIL_FROM=HaloTaskPro <noreply@yourdomain.com>
```

**SMTP will be tried first**, if it fails, Resend takes over. See [DUAL_EMAIL_TRANSPORT.md](DUAL_EMAIL_TRANSPORT.md) for complete setup guide.

### Testing Email Flow

1. Visit `/forgot-password`
2. Enter test email address
3. Check server logs for delivery status:
   ```
   [Auth] Provider: SMTP | Status: SUCCESS | Email: te***@example.com
   ```
   or
   ```
   [Auth] Provider: Resend | Status: SUCCESS | Email: te***@example.com
   ```
4. Check email inbox for reset code
5. Use code to reset password

**Troubleshooting:**
- If email doesn't arrive:
  - Check RESEND_API_KEY is set and valid
  - Check EMAIL_FROM is verified in Resend
  - Check backend logs for send errors
- If reset link is broken:
  - Check APP_BASE_URL matches frontend domain
  - Check token is included in URL
  - Check frontend CLIENT_ORIGIN/VITE_API_BASE_URL correct

---

## Database

### MongoDB Atlas Setup

1. Create cluster at https://www.mongodb.com/cloud/atlas
2. Create database user with strong password
3. Get connection string: `mongodb+srv://user:password@cluster.mongodb.net/dbname`
4. Add backend server IP to IP whitelist
5. Add to backend `.env`:

```env
MONGO_URI=mongodb+srv://user:password@cluster.mongodb.net/halotasks?appName=HaloTasks
```

### Backup and Monitoring

- MongoDB Atlas provides automated daily backups
- Monitor connection health in Atlas dashboard
- Enable alerts for high latency/errors

---

## Security Checklist

Before going live, verify:

- [ ] `CLIENT_ORIGIN` is set to exact frontend domain (no wildcard)
- [ ] `JWT_SECRET` is strong random value (min 32 chars)
- [ ] `MONGO_URI` uses strong password (min 20 chars)
- [ ] HTTPS is enabled on both frontend and backend
- [ ] Backend server IP is added to MongoDB whitelist
- [ ] Resend EMAIL_FROM is verified sender
- [ ] No credentials in git repositories (use .env files)
- [ ] Backend logs don't expose sensitive data
- [ ] Rate limiting is configured (basic in-memory for forgot-password)
- [ ] API keys are rotated periodically
- [ ] CORS is restrictive (exact domain, not wildcard)

---

## Troubleshooting

### "Cannot connect to MongoDB"

```
Error: connect ECONNREFUSED
```

- Check MongoDB connection string format
- Check server IP is in MongoDB whitelist
- Check network connectivity from server
- Check MONGO_DNS_SERVERS fallback is set

### "Frontend gets 401 Unauthorized"

- Check JWT_SECRET matches on server rebuild
- Check token is being sent in Authorization header
- Check token hasn't expired (7 days)

### "Email not sending"

- Check RESEND_API_KEY is valid
- Check EMAIL_FROM is verified in Resend
- Check backend logs for send errors
- Test manually via Resend dashboard

### "CORS errors in browser"

- Check CLIENT_ORIGIN matches exactly (case-sensitive)
- Check backend is restarted after env changes
- Check frontend VITE_API_BASE_URL is correct
- Test with curl: `curl -H "Origin: https://yourdomain.com" ...`

---

## Monitoring

### Recommended Monitoring

- Application health (endpoint response times)
- Error rates (500s, 401s, validation errors)
- Database connection pool health
- Email sending failures
- Password reset link clickthrough rate

### Logging

Backend logs to console. For production, consider:
- Cloud logging (AWS CloudWatch, GCP Stackdriver, etc.)
- Structured logging (JSON format)
- Error tracking (Sentry, Rollbar, etc.)

---

## Rollback Plan

If issues occur after deployment:

1. **Frontend**: Rollback to previous version in hosting provider (usually instant)
2. **Backend**: 
   - Ensure previous stable .env is saved
   - Redeploy previous stable build
   - Database migrations require care - test first

---

## Next Steps

1. Update this guide as deployment progresses
2. Add monitoring and alerting
3. Set up CI/CD pipeline for automated deployments
4. Document scaling strategy as traffic grows
5. Plan database migration strategy for future updates
