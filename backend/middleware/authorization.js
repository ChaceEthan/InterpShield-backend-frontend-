export const ADMIN_ROLES = new Set(["admin", "super_admin"]);

export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role || "user")) {
    res.status(403).json({ error: "Access denied." });
    return;
  }
  next();
};

export const requireAdmin = requireRole("admin", "super_admin");
export const requireSuperAdmin = requireRole("super_admin");
export const isAccountActive = (user) => Boolean(user) && (user.status || "active") === "active";

export const canManageUser = (actor, target) => {
  if (!ADMIN_ROLES.has(actor?.role)) return false;
  if (target?.role === "super_admin" && actor.role !== "super_admin") return false;
  return true;
};
