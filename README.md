# 🌟 HaloTaskPro

HaloTaskPro is a modern productivity application built for people who want more than a checklist.

It helps users **capture tasks, stay focused, work offline, recover from interruptions, and build consistency over time**. Instead of being another place to dump unfinished intentions, it's designed to actively support execution.

At its heart, HaloTaskPro blends clean task management, smart reminders, resilient sync systems, and a playful Growth Tree that rewards momentum.

> Built to help people finish what they start.

---

## 🔗 Live Links

- **Live App (Vercel):** https://halotask-pro.vercel.app
- **Backend API (Render):** https://halotask-pro.onrender.com
- **Backend API (Railway backup):** https://halotask-pro-production.up.railway.app
- **Repository:** https://github.com/Mystify7777/Halotask-Pro
- **Deployment Guide:** [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- **CORS Guide:** [docs/CORS.md](docs/CORS.md)

---

## ✨ Why HaloTaskPro Exists

Most to-do apps are excellent at storing tasks.

Very few are good at helping users *act on them*.

HaloTaskPro was built to close that gap.

It doesn't just ask "What needs to be done?" — it asks:

- **What should be done first?** (Smart prioritization across overdue, due today, upcoming)
- **When should I begin?** (Reminders timed to task duration + your availability)
- **What if I lose internet?** (Offline-first, works everywhere)
- **How do I stay consistent?** (Growth Tree makes progress visible)

---

## 🚀 Core Features

### 📋 Task Management Built for Speed

- Create, edit, complete, and delete tasks instantly
- Priorities, due dates, tags, estimated duration
- Full-text search across all tasks
- Filter by status, tags, priority, or date range
- Sort by urgency, time due, or creation order
- Bulk actions for rapid clearing (mark done, archive, delete multiple)

**Why it matters:** Staring at 23 tasks and choosing where to start is its own task. We help you see what matters first.

---

### 🧠 Smart Sections That Reduce Decision Fatigue

Instead of one overwhelming list, HaloTaskPro surfaces contextual views:

- **Overdue** — What fell through the cracks
- **Due Today** — Your focus list for now
- **Upcoming** — What's coming soon
- **Completed Today** — Visible wins to build momentum
- **Workload** — Estimated hours so you don't over-commit

---

### 🔔 Intelligent Reminder System

Reminders are only useful when they arrive at the *right time*.

HaloTaskPro includes:

- **Due soon alerts** — Get ahead of deadlines
- **Overdue nudges** — Non-intrusive prompts
- **Smart start reminders** — "Begin this task now" based on duration + your calendar
- **Quiet hours** — No alerts while you're focused or sleeping
- **Customizable preferences** — Your rhythm, your rules

---

### 📡 Built for Real Life (Offline First)

Internet disappears. Trains lose signal. Wi-Fi lies.

HaloTaskPro keeps working:

- **IndexedDB cache** — Instant loads, no wait
- **Offline creation** — Tasks sync when reconnected
- **Write queue** — Edits stay safe while offline
- **Auto-reconnect** — Replays queued changes seamlessly
- **Manual sync** — One tap to force a sync retry
- **Pending indicators** — Clear visibility of what's queued

Your productivity should never depend on your router's mood.

---

### 🌳 Growth Tree — The Signature Feature

As tasks are completed, your personal tree grows stronger.

- **Gain XP** from finished work
- **Unlock growth stages** through consistent action
- **Build streaks** that stay visible
- **Visual consequence** — Neglect it, and it wilts

A gentle, persistent reminder that habits grow the same way trees do: slowly, then all at once.

---

### 🔐 Secure Authentication

- Register / Login / Logout flows
- Protected dashboard routes
- Forgot password recovery
- Secure reset tokens with 20-minute expiry
- Single-use reset links (no token reuse)
- Rate-limited recovery requests (abuse protection)
- Email delivery via Resend for reliability

Forgetting a password is human. Suffering to recover shouldn't be.

---

## 🛠 Tech Stack

**Frontend:** React + TypeScript + Vite + Zustand + Axios  
**Backend:** Node.js + Express + TypeScript + MongoDB + Mongoose + JWT  
**Offline:** IndexedDB via `idb`  
**Email:** Resend API  

---

## 🧱 Engineering Highlights

HaloTaskPro was built with real production thinking:

- **Modular React** — Hook-based components with clear boundaries
- **Offline-first sync** — Queue-based recovery that survives network flakiness
- **Secure auth** — Hashed tokens, single-use recovery, rate limiting
- **Responsive design** — Works on phone, tablet, desktop
- **Production-ready** — Strict TypeScript, error handling, CORS security

Built like a product, not a tutorial.

---

## 🚀 Quick Start

### Local Development

**Backend:**

```bash
cd halotasks-server
cp .env.example .env
# Update MONGO_URI and JWT_SECRET in .env
npm install
npm run dev
```

**Frontend:**

```bash
cd halotasks-client
cp .env.example .env
# Keep VITE_API_BASE_URL as http://localhost:5000 for local dev
npm install
npm run dev
```

Frontend runs on `http://localhost:5173`, backend on `http://localhost:5000`.

---

### Production Build

```bash
# Backend
cd halotasks-server && npm run build
# Output: dist/ (compiled JavaScript)

# Frontend
cd halotasks-client && npm run build
# Output: dist/ (optimized static files)
```

See [**docs/DEPLOYMENT.md**](docs/DEPLOYMENT.md) for full production deployment, CORS setup, and email configuration.

---

## 🔑 Environment Variables

### Backend (.env)

```env
# Server
PORT=5000

# Database
MONGO_URI=mongodb+srv://user:password@cluster.mongodb.net/halotasks
MONGO_DNS_SERVERS=8.8.8.8,1.1.1.1

# Auth
JWT_SECRET=<generate-with-openssl-rand-base64-32>
CLIENT_ORIGIN=http://localhost:5173

# Email & Password Reset
APP_BASE_URL=http://localhost:5173
RESEND_API_KEY=re_XXXXXXXXX
EMAIL_FROM=noreply@yourdomain.com
RESET_TOKEN_TTL_MINUTES=20
```

### Frontend (.env)

```env
VITE_API_BASE_URL=http://localhost:5000
```

---

## 📚 Documentation

- [**docs/DEPLOYMENT.md**](docs/DEPLOYMENT.md) — Production deployment guide (Heroku, Railway, Docker, Vercel, Netlify)
- [**docs/CORS.md**](docs/CORS.md) — CORS configuration & troubleshooting
- Product docs in [docs/product/](docs/product/) directory
- Operational docs in [docs/ops/](docs/ops/) directory
- API reference in [docs/06_API_Contract.md](docs/06_API_Contract.md)

---

## 🗺 Current Status & Roadmap

### ✅ Delivered

- Full auth system with password recovery
- Task CRUD with real-time sync
- Search, filters, sorting, bulk actions
- Smart sections (overdue, due today, upcoming, completed today, workload)
- Offline-first architecture with IndexedDB cache
- Sync queue with auto-reconnect
- Reminder engine with quiet hours
- Growth Tree progression system

### 🎯 Planned

- Landing page with smart entry routing
- Analytics & usage insights
- Cloud sync for Growth Tree state
- Shared/team productivity mode
- Email reminder expansion
- Dark mode theme

---

## 📈 What This Project Demonstrates

HaloTaskPro is a full-stack portfolio project showcasing:

- **Full-stack development** — React to database, end-to-end
- **Offline-first architecture** — Complex sync patterns that feel seamless
- **Secure auth flows** — Production-grade password recovery
- **Real UX thinking** — Features designed for actual use, not just feature lists
- **Scalable patterns** — Clean separation of concerns, modular design
- **DevOps readiness** — Docker-ready, multi-environment config, deployment docs

---

## 🔒 Security Notes

- JWT tokens expire after 7 days
- Reset tokens expire after 20 minutes (configurable)
- Reset tokens are hashed before storage (not readable in DB)
- Password reset is single-use (token deleted after use)
- CORS restricted to single origin per environment
- Rate limiting on forgot-password endpoint
- Neutral error messages prevent email enumeration

---

## 💡 Philosophy

HaloTaskPro exists because:

1. **Most to-do apps solve storage, not execution**
2. **Consistency matters more than perfection**
3. **Offline support is table stakes, not nice-to-have**
4. **Productivity should feel good, not stressful**

It's built with the belief that people rarely lack tasks—they lack clarity on *which* task to do first, and confidence that they can actually finish it.

---

## 👤 Build Notes

This project prioritizes:

- ✅ Production-ready patterns over quick hacks
- ✅ User experience over feature quantity
- ✅ Maintainable code over clever code
- ✅ Real offline support over "works when online"
- ✅ Secure auth over convenience auth

Because building something people actually *use* is harder than building something people might *try*.
