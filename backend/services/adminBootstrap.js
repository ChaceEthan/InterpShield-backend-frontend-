import { seedAdmin } from "../scripts/seedAdmin.mjs";

const SUCCESS_MESSAGE = "Super admin account initialized securely.";
const FAILURE_MESSAGE = "Super admin initialization failed securely.";

/**
 * Run the opt-in startup bootstrap without exposing configuration or blocking
 * normal server startup when initialization fails.
 *
 * @param {{
 *   config: {adminEmail?: string, adminPasswordHash?: string, adminResetPasswordOnSeed?: boolean},
 *   seed?: typeof seedAdmin,
 *   logger?: Pick<Console, "info" | "error">
 * }} options
 * @returns {Promise<boolean>}
 */
export const runStartupAdminBootstrap = async ({ config, seed = seedAdmin, logger = console }) => {
  const enabled =
    config.adminResetPasswordOnSeed === true &&
    Boolean(config.adminEmail) &&
    Boolean(config.adminPasswordHash);

  if (!enabled) return false;

  try {
    await seed({ config });
    logger.info(SUCCESS_MESSAGE);
    return true;
  } catch {
    logger.error(FAILURE_MESSAGE);
    return false;
  }
};
