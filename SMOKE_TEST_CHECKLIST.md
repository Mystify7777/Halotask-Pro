# HaloTaskPro Smoke Test Checklist

**Status:** Backend ✅ Running | Frontend ✅ Ready | Database ✅ Connected

---

## 1. AUTH TESTS
Go to http://localhost:5173

### Register
- [ ] Click "Sign Up" or go to `/register`
- [ ] Enter email: `testuser+smoke@test.com`
- [ ] Enter password: `Test@12345`
- [ ] Confirm password: `Test@12345`
- [ ] Click Register
- **Expected:** Redirects to login, shows success message

### Login
- [ ] Enter email: `testuser+smoke@test.com`
- [ ] Enter password: `Test@12345`
- [ ] Click Login
- **Expected:** Redirects to dashboard, shows task list

### Refresh Session
- [ ] While on dashboard, refresh the page (F5)
- **Expected:** Still logged in, no redirect to login

### Logout
- [ ] Look for logout button (usually in header/profile)
- [ ] Click Logout
- **Expected:** Redirects to login page

---

## 2. CORE TASK TESTS

### Create Task
- [ ] Click "Add Task" or "New Task" button
- [ ] Enter title: `Test Task - Smoke`
- [ ] Enter description: `This is a test task`
- [ ] Set priority: `High`
- [ ] Set due date: Tomorrow at 2 PM
- [ ] Set estimated time: `30 minutes`
- [ ] Add tags: `test`, `smoke`
- [ ] Click Create/Save
- **Expected:** Task appears in list with all fields visible

### Edit Task
- [ ] Find the task you just created
- [ ] Click edit icon or double-click task
- [ ] Change title to: `Test Task - Updated`
- [ ] Change priority to: `Low`
- [ ] Click Save
- **Expected:** Task updates in list without full page reload

### Complete Toggle
- [ ] Find the task in the list
- [ ] Click the checkbox or complete button
- **Expected:** Task gets strikethrough, marked as completed
- [ ] Click again to uncomplete
- **Expected:** Strikethrough removed, marked as incomplete

### Delete Task
- [ ] Click delete icon on any task
- [ ] Confirm deletion if prompted
- **Expected:** Task disappears from list

---

## 3. FILTER TESTS

### Search
- [ ] Create multiple tasks with different titles (if not already done)
- [ ] Type in search box: `test`
- **Expected:** Only tasks with "test" in title/description shown
- [ ] Clear search
- **Expected:** All tasks reappear

### Status Filter
- [ ] Look for status filter dropdown
- [ ] Select: `Completed`
- **Expected:** Only completed tasks shown
- [ ] Select: `Incomplete`
- **Expected:** Only incomplete tasks shown
- [ ] Select: `All`
- **Expected:** All tasks shown

### Priority Filter
- [ ] Look for priority filter
- [ ] Select: `High`
- **Expected:** Only high priority tasks shown
- [ ] Select: `Medium`
- **Expected:** Only medium priority tasks shown
- [ ] Select: `Low`
- **Expected:** Only low priority tasks shown
- [ ] Select: `All`
- **Expected:** All tasks shown

### Tags Filter
- [ ] Look for tags filter section
- [ ] Click on a tag that multiple tasks have
- **Expected:** Only tasks with that tag shown
- [ ] Click tag again to deselect
- **Expected:** All tasks reappear
- [ ] Select multiple tags
- **Expected:** Tasks matching ANY selected tag shown (or ALL, depending on design)

### Sorting
- [ ] Look for sort dropdown/button
- [ ] Test each sort option (if available):
  - [ ] Sort by Date (newest first)
  - [ ] Sort by Date (oldest first)
  - [ ] Sort by Priority (high to low)
  - [ ] Sort by Priority (low to high)
  - [ ] Sort by Title (A-Z)
  - [ ] Sort by Title (Z-A)
- **Expected:** Task order changes accordingly

---

## 4. BULK OPERATION TESTS

### Select Visible
- [ ] Look for "Select All" checkbox in list header
- [ ] Click "Select All"
- **Expected:** All visible tasks get checkmarks
- [ ] Checkmarks visible on each task card

### Complete Selected
- [ ] With tasks selected, look for bulk action bar
- [ ] Click "Complete Selected" or "Mark Complete"
- **Expected:** All selected tasks marked as completed, removed from "incomplete" view
- [ ] Checkboxes cleared

### Delete Selected
- [ ] Select multiple tasks again (using individual checkboxes)
- [ ] Look for "Delete Selected" option
- [ ] Click it
- [ ] Confirm deletion if prompted
- **Expected:** All selected tasks deleted from list

---

## 5. OFFLINE TESTS

### Simulate Offline
- [ ] Open browser DevTools (F12)
- [ ] Go to Network tab
- [ ] Click throttling dropdown, select "Offline"
- [ ] Or disable WiFi/unplug ethernet
- **Expected:** You're now offline, app shows offline indicator

### Create Task Offline
- [ ] While offline, create a new task
- [ ] Enter title: `Offline Test Task`
- [ ] Fill in other fields
- [ ] Click Create
- **Expected:** 
  - [ ] Task appears in list immediately (optimistic update)
  - [ ] Pending sync indicator appears (spinning icon, "pending" badge, or similar)
  - [ ] Task is saved locally (IndexedDB)

### Check Pending Queue
- [ ] Look for sync status or pending count indicator
- [ ] Should show: `1 pending sync` or similar
- [ ] Look for pending marker on the task you just created

### Reconnect and Sync
- [ ] Enable network again (DevTools offline → online, or reconnect WiFi)
- **Expected:**
  - [ ] Pending indicator disappears
  - [ ] Task syncs to server
  - [ ] Pending count shows `0`
  - [ ] Toast/notification shows "Synced" or "Sync complete"

### Manual Retry Sync (if available)
- [ ] Look for manual retry button or sync button
- [ ] If pending items, click it
- **Expected:** Queue processes and clears

---

## 6. REMINDER TESTS

### Open Reminder Settings
- [ ] Look for reminder icon/button (usually on sync status bar)
- [ ] Click it to open settings modal
- **Expected:** Modal shows reminder controls

### Change Buffer Time
- [ ] Find "Buffer Time" or "Alert Before" dropdown
- [ ] Change buffer: `15 minutes`
- **Expected:** Setting persists (check localStorage)
- [ ] Try other buffers: `30`, `60`, `90` minutes
- **Expected:** Each saves without error

### Toggle Reminder Types
- [ ] Look for reminder type checkboxes:
  - [ ] `Due Soon` (tasks due in next hour)
  - [ ] `Overdue` (past due tasks)
  - [ ] `Start Time` (tasks it's time to start)
  - [ ] `Work Session` (upcoming work sessions)
- [ ] Toggle each on/off
- **Expected:** Each toggles without error, settings persist

### Quiet Hours
- [ ] Find "Quiet Hours" or "Do Not Disturb" section
- [ ] Set start time: `22:00` (10 PM)
- [ ] Set end time: `08:00` (8 AM)
- [ ] Click Save
- **Expected:** Settings persist

### Test Notification (Optional)
- [ ] Create a task with due date/time in next 5 minutes
- [ ] Wait for notification
- **Expected:** Browser notification appears with reminder message

---

## Summary

### ✅ Passing Criteria
- All auth flows work (register, login, logout, refresh)
- CRUD operations work (create, read, update, delete)
- Filters work (search, status, priority, tags, sorting)
- Bulk operations work (select, complete, delete)
- Offline mode works (create offline, pending marker, sync on reconnect)
- Reminders work (settings persist, notifications trigger)

### ⚠️ Known Limitations / Future
- Email reminders not yet implemented
- Growth Tree feature coming next
- Advanced analytics on roadmap

### 📝 Notes
- All data is test data, feel free to delete
- Check browser console (F12) for any errors
- If test fails, check Network tab to see API responses
- Backend logs (server terminal) show request details

---

**Test started:** $(date)
**Tested by:** Manual UI Testing
**Environment:** Local Dev (localhost:5173)
