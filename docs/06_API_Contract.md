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

### GET /api/tasks
Response shape:
```json
{
  "tasks": []
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
  "dueDate": "2026-04-21"
}
```

Task response shape:
```json
{
  "_id": "...",
  "title": "Study DSA",
  "completed": false,
  "priority": "high",
  "tags": ["study"],
  "dueDate": "2026-04-21"
}
```

### PUT /api/tasks/:id
Request body:
```json
{
  "completed": true,
  "priority": "medium"
}
```

### DELETE /api/tasks/:id
Response:
```json
{
  "message": "Task deleted"
}
```