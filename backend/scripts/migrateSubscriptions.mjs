import { connectDatabase } from "../config/database.js";
import { env } from "../config/env.js";
import { migrateLegacySubscriptions } from "../services/subscriptionJobs.js";
await connectDatabase(env); console.log(await migrateLegacySubscriptions()); process.exit(0);
