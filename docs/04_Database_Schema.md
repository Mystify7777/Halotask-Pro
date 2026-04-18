# Database Schema

## User
- _id
- name
- email
- passwordHash
- createdAt

## Task
- _id
- userId
- title
- description
- completed
- priority
- tags[]
- dueDate
- estimatedMinutes
- reminderSent
- createdAt
- updatedAt

## TreeProgress
- _id
- userId
- streakDays
- health
- leaves
- species
- lastActiveDate
