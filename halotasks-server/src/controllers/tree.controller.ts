import { NextFunction, Request, Response } from 'express';
import User from '../models/User.model';

const VALID_HEALTH  = new Set(['healthy', 'wilting', 'dead']);
const VALID_STAGE   = new Set(['seed', 'sprout', 'young', 'mature', 'lush']);

export const getTree = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById(req.user?.id).select('treeState');
    if (!user) return res.status(404).json({ message: 'User not found' });
    return res.json({ treeState: user.treeState });
  } catch (error) {
    return next(error);
  }
};

export const patchTree = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as Record<string, unknown>;

    // Fetch current state for the anti-cheat XP check
    const user = await User.findById(req.user?.id).select('treeState');
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Anti-cheat: XP is append-only — reject any attempt to decrease it
    const currentXp = (user.treeState as Record<string, unknown> | undefined)?.xp;
    const incomingXp = body.xp;
    if (
      typeof incomingXp === 'number' &&
      typeof currentXp  === 'number' &&
      incomingXp < currentXp
    ) {
      return res.status(400).json({ message: 'XP cannot decrease' });
    }

    // Build a clean $set update — only include fields that pass validation
    const patch: Record<string, unknown> = {};

    if (typeof incomingXp === 'number' && incomingXp >= 0)
      patch['treeState.xp'] = Math.floor(incomingXp);

    if (typeof body.leaves === 'number')
      patch['treeState.leaves'] = Math.max(0, Math.floor(body.leaves));

    if (typeof body.streakDays === 'number')
      patch['treeState.streakDays'] = Math.max(0, Math.floor(body.streakDays));

    if (typeof body.lastActiveDate === 'string' || body.lastActiveDate === null)
      patch['treeState.lastActiveDate'] = body.lastActiveDate;

    if (typeof body.health === 'string' && VALID_HEALTH.has(body.health))
      patch['treeState.health'] = body.health;

    if (typeof body.stage === 'string' && VALID_STAGE.has(body.stage))
      patch['treeState.stage'] = body.stage;

    if (typeof body.lastCalculatedAt === 'string')
      patch['treeState.lastCalculatedAt'] = body.lastCalculatedAt;

    if (Array.isArray(body.awardedTaskIds))
      patch['treeState.awardedTaskIds'] = body.awardedTaskIds.filter(
        (id): id is string => typeof id === 'string',
      );

    const updated = await User.findByIdAndUpdate(
      req.user?.id,
      { $set: patch },
      { returnDocument: 'after', select: 'treeState' },
    );

    return res.json({ treeState: updated?.treeState });
  } catch (error) {
    return next(error);
  }
};
