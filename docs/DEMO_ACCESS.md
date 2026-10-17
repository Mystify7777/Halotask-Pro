# Demo access (Issue #33)

HaloTaskPro has **no shared demo login**. No username/password pair for the live app is published, and none may be
committed to this repository (README, docs, changelog, tests, fixtures, scripts, `.env*` files or screenshots).

## How a visitor explores the live app

Open the live app (linked from the README) and **Register**. Registration is open: a name, an email address and a
password. There is no email verification and no SMTP dependency. The new account is an ordinary user:

- it starts empty (no tasks, no history, no push subscriptions, an unstarted Growth Tree), so there is no data to leak;
- it can read and change only its own data. Every task, history, push-subscription and Growth Tree query on the server
  is keyed on the user id taken from the verified session token (`req.user.id`), never on anything the client sends;
- it has no special role: the server has no admin or demo tier, so "demo access" is not a privilege.

Visitors are asked to use a throwaway password they do not use anywhere else.

## If a maintainer wants to hand out a guided demo account

Create it out of band and give the credentials to people directly (chat, email, a live session), never in the repo:

1. Register the account through the normal Register form with a fresh, unique, randomly generated password (and an
   address that is not a personal mailbox).
2. Fill it only with synthetic data (invented task titles, no real names, addresses or links).
3. Keep the password in the maintainer's password manager, not in a file in this repository.
4. Rotate it on a schedule and whenever it may have been shared more widely than intended (see below). Remove the
   account when the demo is over.

## Rotating or revoking a demo account

The password-reset email flow is currently unavailable in production (see the README notice), so revoke with the
database directly, using a MongoDB shell or Atlas against the production cluster:

1. Delete the account (`users` collection, and that user's `tasks` and `dayhistories` documents), **or**
2. Replace `passwordHash` with a hash of a new random password **and** increment `tokenVersion`. Incrementing
   `tokenVersion` makes every session token issued before the change fail with `401`. Rotating `JWT_SECRET` revokes
   every account's sessions and is a last resort.

A password that was ever committed stays in git history and in any fork or clone. Rotation is the fix; rewriting
history only reduces exposure and does not make the old value safe again. If the same password is used anywhere else
(for example on the mailbox the account was registered with), change it there too.

## Guard

`halotasks-server/tests/noPublishedCredentials.test.ts` fails if a Markdown file in the repository (or the changelog)
contains a credential written as a label followed by a value (for example a password line). `tests/api.routes.test.ts` ("isolation between accounts") checks, against
a real MongoDB, that one account cannot read or change another account's tasks, history, push subscriptions or Growth Tree.
