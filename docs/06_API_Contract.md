# API Contract

## Auth

### POST /api/auth/register
Request body:
```json
{
  "name": "User",
  "email": "user@mail.com",
  "password": "123456"
}
```

Response:
```json
{
  "token": "<jwt>",
  "user": {
    "id": "<user-id>",
    "name": "User",
    "email": "user@mail.com"
  }
}
```

### POST /api/auth/login
Request body:
```json
{
  "email": "user@mail.com",
  "password": "123456"
}
```

Response:
```json
{
  "token": "<jwt>",
  "user": {
    "id": "<user-id>",
    "name": "User",
    "email": "user@mail.com"
  }
}
```

## Tasks

All task routes require `Authorization: Bearer <jwt>`.

Task object shape:
```json
{
  "_id": "...",
  "userId": "...",
  "title": "Study DSA",
  "description": "Solve problems",
  "completed": false,
  "priority": "high",
  "tags": ["study"],
  "dueDate": "2026-04-21T00:00:00.000Z",
  "estimatedMinutes": 90,
  "reminderSent": false,
  "createdAt": "...",
  "updatedAt": "..."
}
```

### GET /api/tasks
Response shape:
```json
{
  "tasks": [
    {
      "_id": "...",
      "title": "Study DSA",
      "completed": false,
      "priority": "high"
    }
  ]
}
```

### POST /api/tasks
Request body:
```json
{
  "title": "Study DSA",
  "description": "Solve problems",
  "completed": false,
  "priority": "high",
  "tags": ["study"],
  "dueDate": "2026-04-21",
  "estimatedMinutes": 90,
  "reminderSent": false
}
```

Response:
```json
{
  "task": {
    "_id": "...",
    "title": "Study DSA",
    "completed": false,
    "priority": "high",
    "tags": ["study"],
    "dueDate": "2026-04-21T00:00:00.000Z",
    "estimatedMinutes": 90,
    "reminderSent": false
  }
}
```

### PUT /api/tasks/:id
Request body:
```json
{
  "title": "Study DSA - Rev 2",
  "description": "Solve medium and hard problems",
  "completed": true,
  "priority": "medium",
  "tags": ["study", "dsa"],
  "dueDate": "2026-04-22",
  "estimatedMinutes": 120,
  "reminderSent": false
}
```

Response:
```json
{
  "task": {
    "_id": "...",
    "completed": true
  }
}
```

### DELETE /api/tasks/:id
Response:
```json
{
  "message": "Task deleted"
}
```

## Error Patterns

Common errors:
- `400` validation errors (missing required fields)
- `401` invalid/missing auth
- `404` task not found or not owned by requester
- `409` duplicate auth registration email