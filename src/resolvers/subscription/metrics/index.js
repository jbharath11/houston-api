import queries from "./queries";
// eslint-disable-next-line import/extensions
import sampleData from "./sample.json";
import log from "logger";
import createPoller from "pubsub/poller";
import config from "config";
import request from "request-promise-native";

// Use sample data if prom is not enabled
const useSample = !config.get("prometheus.enabled");

// Build the Prometheus request URL
export function buildURI(query) {
  const host = config.get("prometheus.host");
  const port = config.get("prometheus.port");
  return `http://${host}:${port}/api/v1/${query}`;
}

// Start the subscription to poll PromQL metrics
export async function subscribe(parent, args, { db, pubsub }) {
  // Get the release name of the current deployment
  let { releaseName } = await db.query.deployment(
    { where: { id: args.deploymentUuid } },
    `{ releaseName }`
  );

  // Poll interval
  const interval = config.get("prometheus.pollInterval");

  // Return a wrapped asyncIterator, killing the subscription after 20 minutes.
  return createPoller(
    async publish => {
      if (useSample) {
        publish({ metrics: [...sampleData] });
      } else {
        const getQueries = queries(releaseName, args.since, args.step);
        const data = [];
        Object.keys(getQueries).forEach(async k => {
          if (args.metricType.indexOf(k) > -1) {
            const promises = getQueries[k].map(async ql => {
              const response = await request({
                method: "GET",
                json: true,
                uri: buildURI(ql.query)
              }).catch(err => log.debug(err));

              return {
                label: ql.name,
                result: response.data ? response.data.result : [],
                uri: buildURI(ql.query)
              };
            });
            data.push(...promises);
          }
        });

        // Capture all the promise results
        const results = await Promise.all(data);
        publish({ metrics: results });
        log.info(`${data.length} metrics for ${releaseName} sent.`);
      }
    },
    pubsub,
    interval,
    1200000
  );
}

export default { subscribe };
