# System Architecture

## Frontend
- React
- TypeScript
- Vite
- Zustand
- Axios
- CSS modules/stylesheets

## Backend
- Node.js
- Express.js
- JWT auth
- Mongoose models/controllers/routes

## Database
- MongoDB Atlas

## Offline Layer
- IndexedDB (idb)
- Cache-first reads
- Write queue with reconnect replay
- Manual retry sync controls

## Notifications
- Browser Notification API
- In-app reminder settings
- Smart start-time calculation (due date + estimate + buffer)

## Sync/State Reliability
- Optimistic UI updates when offline
- Queue action collapse for repeated updates
- Pending sync indicators per task
- Errors-pending state with retry button

## Deployment
- Frontend: Vercel / Netlify
- Backend: Render / Railway
- DB: MongoDB Atlas

## Current Exclusions
- No email reminder pipeline yet
- No service worker/PWA install flow yet
- No Growth Tree engine yet