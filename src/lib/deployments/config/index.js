import { parseJSON } from "utilities";
import log from "logger";
import {
  curry,
  find,
  fromPairs,
  get,
  isNumber,
  last,
  map,
  mapValues,
  maxBy,
  merge,
  set,
  split
} from "lodash";
import config from "config";
import yaml from "yamljs";
import {
  DEPLOYMENT_PROPERTY_EXTRA_AU,
  DEPLOYMENT_PROPERTY_ALERT_EMAILS,
  DEPLOYMENT_PROPERTY_COMPONENT_VERSION,
  AIRFLOW_EXECUTOR_LOCAL,
  AIRFLOW_EXECUTOR_CELERY,
  AIRFLOW_COMPONENT_SCHEDULER,
  AIRFLOW_COMPONENT_WORKERS,
  AIRFLOW_COMPONENT_PGBOUNCER,
  DEFAULT_NEXT_IMAGE_TAG
} from "constants";

/*
 * Generate the full helm configuration for a deployment.
 * @param {Object} deployment The deployment for this configuration.
 * @return {Object} The final helm values.
 */
export function generateHelmValues(deployment, values = {}) {
  const base = config.get("deployments.helm") || {};
  const logValues = config.get("deployments.logHelmValues");

  const helmValues = merge(
    {}, // Start with an empty object.
    base, // Apply base settings from config YAML.
    values, // Apply any settings passed in directly.
    ingress(), // Apply ingress settings.
    defaultResources(), // Apply resource requests and limits.
    limitRange(), // Apply the limit range.
    constraints(deployment), // Apply any constraints (quotas, pgbouncer, etc).
    registry(deployment), // Apply the registry connection details.
    elasticsearch(deployment), // Apply the elasticsearch connection details
    // platform(deployment), // Apply astronomer platform specific values.
    deploymentOverrides(deployment) // The deployment level config.
  );

  // Log out the YAML values if enabled.
  logValues &&
    log.info(`Final helm values: \n${yaml.stringify(helmValues, 4)}`);

  return helmValues;
}

/*
 * Return the Ingress configuration.
 * @return {Object} Ingress values.
 */
export function ingress() {
  const { baseDomain, releaseName } = config.get("helm");

  return {
    ingress: {
      baseDomain,
      class: `${releaseName}-nginx`
    }
  };
}

/*
 * Return the LimitRange configuration.
 * @return {Object} LimitRange values.
 */
export function limitRange() {
  if (config.get("helm.singleNamespace")) {
    // If the platform and airflow are deployed in the same namespace we can't
    // usefully enforce any quotas.
    return {};
  }

  const { astroUnit, maxPodAu } = config.get("deployments");
  const max = auToResources(astroUnit, maxPodAu);
  const min = auToResources(astroUnit, 1);

  const podLimit = {
    type: "Pod",
    max
  };

  const containerLimit = {
    type: "Container",
    default: min,
    defaultRequest: min,
    min
  };

  return { limits: [podLimit, containerLimit] };
}

/*
 * Return the resource quotas, pgbouncer limits, and other settings
 * based on the totals calculated from this deployment.
 * @param {Object} deployment Deployment
 * @return {Object} Quotas, etc.
 */
export function constraints(deployment) {
  if (config.get("helm.singleNamespace")) {
    // If the platform and airflow are deployed in the same namespace we can't
    // usefully enforce any quotas.
    return {};
  }

  // Get some config settings.
  const { astroUnit, components, executors } = config.get("deployments");

  // Get the executor on this deployment.
  const executor = get(deployment, "config.executor", AIRFLOW_EXECUTOR_CELERY);

  // Get the configuration for that executor.
  const executorConfig = find(executors, ["name", executor]);

  // Calculate the total resources required.
  const total = executorConfig.components.reduce(
    (acc, cur) => {
      // Get the component configuration from static config.
      const component = find(components, ["name", cur]) || {};
      const defaults = auToResources(astroUnit, component.au.default);

      // Get cpu and memory for this component out of deployment config,
      // falling back to static config vaules.
      const { cpu, memory } = get(
        deployment,
        `config.${cur}.resources.limits`,
        defaults
      );

      // Check if deployment config has replicas.
      const replicas = get(deployment, `config.${cur}.replicas`, 1);

      // Return combined.
      return {
        cpu: acc.cpu + parseInt(cpu) * replicas,
        memory: acc.memory + parseInt(memory) * replicas,
        pods: acc.pods + replicas
      };
    },
    { cpu: 0, memory: 0, pods: 0 }
  );

  const sidecars = executorConfig.components.reduce(
    (acc, cur) => {
      const replicas = get(deployment, `${cur}.replicas`, 1);
      if (
        executor === AIRFLOW_EXECUTOR_LOCAL &&
        cur === AIRFLOW_COMPONENT_SCHEDULER
      ) {
        // LocalExecutor has a log server and worker log trimming sidecars.
        return {
          cpu: acc.cpu + parseInt(astroUnit.cpu) * 2,
          memory: acc.memory + parseInt(astroUnit.memory) * 2
        };
      } else if (cur === AIRFLOW_COMPONENT_WORKERS) {
        // Workers have a log trimming sidecar.
        return {
          cpu: acc.cpu + parseInt(astroUnit.cpu) * replicas,
          memory: acc.memory + parseInt(astroUnit.memory) * replicas
        };
      } else if (cur === AIRFLOW_COMPONENT_PGBOUNCER) {
        // Pgbouncer has a sidecar metrics exporter.
        return {
          cpu: acc.cpu + parseInt(astroUnit.cpu),
          memory: acc.memory + parseInt(astroUnit.memory)
        };
      }
      return acc;
    },
    { cpu: 0, memory: 0 }
  );

  // Check for any extra Au on deployment.
  const extraProp = find(deployment.properties, [
    "key",
    DEPLOYMENT_PROPERTY_EXTRA_AU
  ]);
  const extraAu = extraProp ? extraProp.value : 0;

  // Calculate total extra capacity.
  const extra = {
    cpu: parseInt(astroUnit.cpu) * extraAu,
    memory: parseInt(astroUnit.memory) * extraAu,
    pods: parseInt(astroUnit.pods) * extraAu
  };

  // Calculate toatal Au  using totalCPU / astroUnitCPU.
  const totalAu = (total.cpu + extra.cpu) / parseInt(astroUnit.cpu);

  // Set requests/limits quotas.
  const cpu = `${total.cpu * 2 + sidecars.cpu * 2 + extra.cpu}m`;
  const memory = `${total.memory * 2 + sidecars.memory * 2 + extra.memory}Mi`;

  const res = {
    quotas: {
      pods: total.pods * 2 + extra.pods,
      "requests.cpu": cpu,
      "requests.memory": memory,
      "limits.cpu": cpu,
      "limits.memory": memory
    }
  };

  // Set pgbouncer variables.
  set(
    res,
    "pgbouncer.metadataPoolSize",
    Math.floor(astroUnit.actualConns * totalAu)
  );
  set(
    res,
    "pgbouncer.maxClientConn",
    Math.floor(astroUnit.airflowConns * totalAu)
  );

  // If we have extraAu, enable pod launching (KubeExecutor, KubePodOperator, etc).
  if (extraAu > 0) set(res, "allowPodLaunching", true);

  // Return the final object.
  return res;
}

/*
 * Return the resource defaults for each component.
 * @param {String} type Resource type.
 * @param {String} includeUnits If true include millicpu and memory units.
 * @return {Object} The resource values.
 */
export function defaultResources(type = "default", includeUnits = true) {
  const astroUnit = config.get("deployments.astroUnit");
  const components = config.get("deployments.components");
  const mapper = curry(mapResources)(astroUnit, type, includeUnits);
  return merge(...components.map(mapper));
}

/*
 * Return connection information for the docker registry.
 * Each deployment has a unique password that is auto-generated and
 * lives in a kubernetes secret. This function maps those values into
 * the helm configuration.
 * @param {Object} deployment A deployment object.
 * @return {Object} The registry settings.
 */
export function registry(deployment) {
  const { baseDomain } = config.get("helm");

  return {
    registry: {
      connection: {
        user: deployment.releaseName,
        host: `registry.${baseDomain}`,
        email: `admin@${baseDomain}`
      }
    }
  };
}

/*
 * Return connection information for the elasticsearch connection.
 * Each deployment has a unique password that is auto-generated and
 * lives in a kubernetes secret. This function maps those values into
 * the helm configuration.
 * @param {Object} deployment A deployment object.
 * @return {Object} The elasticsearch settings.
 */

export function elasticsearch(deployment) {
  const { connection } = config.get("deployments.elasticsearch");

  return !connection
    ? {}
    : {
        elasticsearch: {
          connection: merge({ user: deployment.releaseName }, connection)
        },
        // This disables StatefulSet workers and uses a Deployment instead.
        // By default we use the Elasticsearch log plugin. This means we print
        // the logs to stdout, which get shipped to Elasticsearch via Fluentd.
        workers: {
          persistence: { enabled: false }
        }
      };
}

/* Return the platform specific settings.
 * @param {Object} deployment A deployment object.
 * @return {Object} Helm values.
 */
// export function platform(deployment) {
//   return {
//     platform: {
//       release: deployment.releaseName,
//       workspace: deployment.workspace.id
//     }
//   };
// }

/*
 * HOF to help create mergeable resources
 * @param {Object} Astro unit config.
 * @param {String} Default/Limit.
 * @param {String} Component name.
 * @return {Object} Resources for single component.
 */
export function mapResources(au, auType, includeUnits, comp) {
  const requests = auToResources(au, comp.au[auType], includeUnits);

  const resources = {
    requests,
    limits: requests
  };

  const extras = comp.extra
    ? comp.extra.map(extra => {
        return {
          [extra.name]: extra[auType]
        };
      })
    : [];

  const merged = merge({ resources }, ...extras);

  return { [comp.name]: merged };
}

/*
 * Convert an AU size to equivalent resources object.
 * @param {Object} au Astro unit definition.
 * @param {Integer} size Amount of astro units.
 * @return {Object} The resources object.
 */
export function auToResources(au, size, includeUnits = true) {
  if (includeUnits) {
    return { cpu: `${au.cpu * size}m`, memory: `${au.memory * size}Mi` };
  }
  return { cpu: au.cpu * size, memory: au.memory * size };
}

/*
 * Transform an array of key/value pairs to an object.
 * @param {[]Object} An array of objects with key/value pairs.
 * @return {Object} The object with key/value pairs.
 */
export function envArrayToObject(arr = []) {
  return fromPairs(arr.map(i => [i.key, i.value]));
}

/*
 * Transform an object of key/value pairs to an array.
 * @param {Object} An array of objects with key/value pairs.
 * @return {[]Object} The object with key/value pairs.
 */
export function envObjectToArray(obj = {}) {
  return map(obj, (val, key) => ({ [key]: val }));
}

/*
 * Map legacy DeploymentProperties to their new top-level names.
 * This is purely to bridge the gap from the legacy API.
 * @param {Object} An object with key/value pairs.
 * @return {[]Object} The object with key/value pairs.
 */
export function mapPropertiesToDeployment(obj = {}) {
  const mapped = {};

  if (obj[DEPLOYMENT_PROPERTY_EXTRA_AU]) {
    mapped.extraAu = obj[DEPLOYMENT_PROPERTY_EXTRA_AU];
  }

  if (obj[DEPLOYMENT_PROPERTY_COMPONENT_VERSION]) {
    mapped.airflowVersion = obj[DEPLOYMENT_PROPERTY_COMPONENT_VERSION];
  }

  if (obj[DEPLOYMENT_PROPERTY_ALERT_EMAILS]) {
    mapped.alertEmails = {
      set: parseJSON(obj[DEPLOYMENT_PROPERTY_ALERT_EMAILS])
    };
  }

  return mapped;
}

/*
 * Map top level deployment fields to legacy properties.
 * This is purely to bridge the gap from the legacy API.
 * @param {Object} An object
 * @return {[]Object} The object with key/value pairs.
 */
export function mapDeploymentToProperties(dep = {}) {
  const mapped = {};

  if (dep.extraAu) {
    mapped[DEPLOYMENT_PROPERTY_EXTRA_AU] = dep.extraAu;
  }

  if (dep.airflowVersion) {
    mapped[DEPLOYMENT_PROPERTY_COMPONENT_VERSION] = dep.airflowVersion;
  }

  if (dep.alertEmails) {
    mapped[DEPLOYMENT_PROPERTY_ALERT_EMAILS] = dep.alertEmails;
  }

  return mapped;
}

/*
 * Find the most recent tag in a list of image tags.
 */
export function findLatestTag(tags = []) {
  const filtered = tags.filter(t => t.startsWith("cli-"));
  return maxBy(filtered, t => last(split(t, "-")));
}

/*
 * Generate the next tag name for a deployment image.
 */
export function generateNextTag(latest) {
  if (!latest) return DEFAULT_NEXT_IMAGE_TAG;
  const num = parseInt(last(split(latest, "-")));
  return `cli-${num + 1}`;
}

/*
 * Generate the default `config` for a new deployment, if nothing
 * is passed to the mutation.
 * @return {Object} The default config.
 */
export function generateDefaultDeploymentConfig() {
  return { executor: AIRFLOW_EXECUTOR_CELERY };
}

/*
 * Generate the deployment specific overrides.
 * Specfically, this currently maps numeric resources
 * values that are sent by orbit to be valid for helm.
 * @param {Object} deployment A deployment object.
 * @return {Object} Properly formatted config, pulled from deployment.
 */
export function deploymentOverrides(deployment) {
  // Get the deployment config.
  const cfg = get(deployment, "config", {});

  // Map over all keys on deployment config, looking for components that have
  // resources defined.
  return mapValues(cfg, val1 => {
    if (val1.resources) {
      // Create a modified component, possibly altering resources.
      const component = {
        ...val1,
        resources: mapValues(val1.resources, val2 => {
          return mapValues(val2, (val3, key3) => {
            // Wrap numeric values with units.
            if (key3 === "cpu" && isNumber(val3)) return `${val3}m`;
            if (key3 === "memory" && isNumber(val3)) return `${val3}Mi`;
            return val3;
          });
        })
      };

      // Currently, orbit sends up limits, which are stored on the deployment
      // config. When we merge these in, we need to ensure that requests and limits match.
      // Typically the first condition here will be hit. Else condition provided as fallback.
      if (component.resources.limits) {
        component.resources.requests = component.resources.limits;
      } else if (component.resources.requests) {
        component.resources.limits = component.resources.requests;
      }

      // Return the new component.
      return component;
    }

    // If no resources defined, just return the object as is.
    return val1;
  });
}
