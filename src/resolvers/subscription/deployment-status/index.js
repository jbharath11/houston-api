// eslint-disable-next-line import/extensions
import sampleData from "./sample.json";
import log from "logger";
import createPoller from "pubsub/poller";
import config from "config";
import request from "request-promise-native";

// Use sample data if prom is not enabled
const useSample = !config.get("prometheus.enabled");

// Return sample as a promise
const samplePromise = new Promise(resolve => {
  resolve(...sampleData);
});

// Build the Prometheus request URL
export function buildURI(query) {
  const host = config.get("prometheus.host");
  const port = config.get("prometheus.port");
  return `http://${host}:${port}/api/v1/${query}`;
}

// Start the subscription
export async function subscribe(parent, args, { pubsub }) {
  const { releaseName } = args;

  // Return sample data
  if (useSample) {
    return createPoller(publish => {
      publish({ deploymentStatus: { result: samplePromise } });
    }, pubsub);
  }

  // Return promQL data if in production
  return createPoller(async publish => {
    const query = `rate(airflow_scheduler_heartbeat{deployment=~"${releaseName}", type="counter"}[1m])`;
    const response = await request({
      method: "GET",
      json: true,
      uri: buildURI(query)
    }).catch(err => log.debug(err));

    publish({ deploymentStatus: { result: response } });
  }, pubsub);
}

export default { subscribe };
