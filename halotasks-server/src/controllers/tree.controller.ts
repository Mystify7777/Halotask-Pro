import { NextFunction, Response } from 'express';
import User from '../models/User.model';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { BODY_MUST_BE_OBJECT, isPlainObject } from '../utils/requestBody';
import { TREE_REWARD_FIELDS, normalizeTreeState } from '../utils/treeRules';

// ── Growth Tree endpoints (Issue #24: the server is authoritative) ──────────────
//
// GET   /api/tree  — the user's tree. Stored values are NORMALISED on the way out (treeRules): leaves,
//                    stage and health are always derived, impossible numbers are repaired IN THE RESPONSE ONLY (a read
//                    never writes; storage is repaired by the next award, see utils/treeAward.ts), and the
//                    response shape is the one clients have always received.
// PATCH /api/tree  — no longer a way to change reward state. XP and the awarded-task ledger only change
//                    when a task is completed (see utils/treeAward.ts, called by the task controller);
//                    streak, date and the derived fields follow from that. Any attempt to send one of
//                    TREE_REWARD_FIELDS is refused with 400 TREE_FIELD_NOT_WRITABLE, never silently
//                    accepted or ignored. A body with none of them is a harmless no-op.

export const TREE_FIELD_NOT_WRITABLE = 'TREE_FIELD_NOT_WRITABLE';

const readTree = async (userId: string) => {
  const user = await User.findById(userId).select('treeState').lean();
  return user ? normalizeTreeState((user as { treeState?: unknown }).treeState, new Date()) : null;
};

export const getTree = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const treeState = await readTree(req.user.id);
    if (!treeState) return res.status(404).json({ message: 'User not found' });
    return res.json({ treeState });
  } catch (error) {
    return next(error);
  }
};

export const patchTree = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const body: unknown = req.body;
    if (!isPlainObject(body)) {
      return res.status(400).json({ message: BODY_MUST_BE_OBJECT });
    }

    // Presence is what matters, not the value: null, 0, [] and NaN-like values are all forgery attempts.
    const forbidden = TREE_REWARD_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(body, field));
    if (forbidden.length > 0) {
      return res.status(400).json({
        message: 'Growth Tree progress is controlled by the server and cannot be written by the client.',
        code: TREE_FIELD_NOT_WRITABLE,
        fields: forbidden,
      });
    }

    const treeState = await readTree(req.user.id);
    if (!treeState) return res.status(404).json({ message: 'User not found' });
    return res.json({ treeState });
  } catch (error) {
    return next(error);
  }
};
