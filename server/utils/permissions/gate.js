import { getSession, currentUserHasPermission } from 'kempo/server/sdk.js';

/*
  The same shape kempo-files uses, for the same reason: a permission check written out longhand in
  every route is one that eventually has a clause wrong somewhere.

  There is no own/others split here. A thumbnail has no author of its own — it belongs to whatever
  it was made from, and kempo-files already decides who may touch that.
*/

export const requireSession = async request => {
  const token = request.cookies?.session_token;
  if(!token) return [{ code: 401, msg: 'Authentication required' }, null];

  const [error, session] = await getSession({ token });
  if(error || !session?.user) return [{ code: 401, msg: 'Authentication required' }, null];

  return [null, { token, user: session.user }];
};

export const requirePermission = async (token, name) => {
  const [error, allowed] = await currentUserHasPermission(token, name);
  if(error) return [{ code: error.code, msg: error.msg }, null];
  if(!allowed) return [{ code: 403, msg: 'Insufficient permissions' }, null];
  return [null, true];
};
