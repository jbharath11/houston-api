// @PromQL
// Queries to gather data for a deployment from Prometheus
import moment from "moment";

// Query Options
const components = `scheduler|webserver|worker|flower|redis|pgbouncer|statsd`;
const duration = `[3m]`;

export default function queries(deployment, since, step) {
  // UNIX current time timestamp
  const now = moment().unix() - (moment().unix() % step);

  // Formatted step
  const fstep = `[${Math.max(step, 60)}s]`;

  // UNIX start timestamp
  const start =
    moment()
      .subtract(since, "minutes")
      .unix() -
    (moment()
      .subtract(since, "minutes")
      .unix() %
      step);

  // Query builders (Prom uses different endpoints for different metrics)
  const query = ql => `query?query=${encodeURI(ql)}&time=${now}`;
  const rangeQuery = ql =>
    `query_range?start=${start}&end=${now}&step=${step}s&query=${encodeURI(
      ql
    )}`;

  return {
    DEPLOYMENT_STATUS: [
      {
        name: "deploymentStatus",
        query: query(
          `sum by (release) (kube_pod_container_status_running{release=~"${deployment}"} and on(pod,namespace) kube_pod_labels{label_dag_id=""}) -
           count by (release) (kube_pod_container_status_running{release=~"${deployment}"} and on(pod,namespace) kube_pod_labels{label_dag_id=""})`
        )
      },
      {
        name: "schedulerHeartbeat",
        query: query(
          `rate(airflow_scheduler_heartbeat{deployment=~"${deployment}", type="counter"}[1m])`
        )
      },
      {
        name: "coreContainerStatus",
        query: query(
          `sort_desc(max by (container, pod, reason) (
            max by (container, pod) (
              sort_desc(kube_pod_container_status_waiting{release=~"${deployment}", container!="istio-proxy"}
              and on(pod,namespace) kube_pod_labels{label_dag_id=""})
            )
            or max by (container, reason) (
              sort_desc(kube_pod_container_status_waiting_reason{release=~"${deployment}", container!="istio-proxy"}==1 and on(pod,namespace) kube_pod_labels{label_dag_id=""})
            )
            or max by (container, reason) (
              sort_desc(kube_pod_container_status_terminated_reason{release=~"${deployment}", container!="istio-proxy"}==1 and on(pod,namespace) kube_pod_labels{label_dag_id=""})
            ))
          )`
        )
      }
    ],
    DEPLOYMENT_TASKS: [
      {
        name: "runningTasks",
        query: rangeQuery(
          `airflow_executor_running_tasks{deployment=~"${deployment}"}`
        )
      },
      {
        name: "queuedTasks",
        query: rangeQuery(
          `airflow_executor_queued_tasks{deployment=~"${deployment}"}`
        )
      },
      {
        name: "failedTasks",
        query: rangeQuery(
          `increase(airflow_ti_failures{deployment=~"${deployment}"}${fstep})`
        )
      },
      {
        name: "successfulTasks",
        query: rangeQuery(
          `increase(airflow_ti_successes{deployment=~"${deployment}"}${fstep})`
        )
      },
      {
        name: "taskStatus",
        query: query(
          `sort_desc(max by (container, pod, reason) (
            max by (container, pod) (
            sort_desc(kube_pod_container_status_waiting{release=~"${deployment}", container!="istio-proxy"} and on(pod,namespace) kube_pod_labels{label_dag_id!=""})  )
            or max by (container, reason) (
            sort_desc(kube_pod_container_status_waiting_reason{release=~"${deployment}", container!="istio-proxy"}==1 and on(pod,namespace) kube_pod_labels{label_dag_id!=""}) )
            or max by (container, reason) (sort_desc(kube_pod_container_status_terminated_reason{release=~"${deployment}", container!="istio-proxy"}==1 and on(pod,namespace) kube_pod_labels{label_dag_id!=""}) )))`
        )
      }
    ],
    DEPLOYMENT_DATABASE: [
      {
        name: "totalDatabaseConnections",
        query: rangeQuery(
          `sum(pgbouncer_exporter_database_current_connections{name!="pgbouncer", deployment=~"${deployment}"})`
        )
      },
      {
        name: "totalWaitingClients",
        query: rangeQuery(
          `sum(pgbouncer_exporter_pools_waiting_clients{database!="pgbouncer", deployment=~"${deployment}"})`
        )
      }
    ],
    DEPLOYMENT_SCHEDULER: [
      {
        name: "heartbeat",
        query: rangeQuery(
          `rate(airflow_scheduler_heartbeat{deployment=~"${deployment}", type="counter"}${duration})*60`
        )
      },
      {
        name: "dagCount",
        query: rangeQuery(
          `sum(airflow_dagbag_size{deployment=~"${deployment}"})`
        )
      },
      {
        name: "zombieCount",
        query: rangeQuery(
          `sum(airflow_zombies_killed{deployment=~"${deployment}"})`
        )
      },
      {
        name: "taskSuccessCount",
        query: rangeQuery(
          `sum(airflow_ti_successes{deployment=~"${deployment}"})`
        )
      },
      {
        name: "taskFailCount",
        query: rangeQuery(
          `sum(airflow_ti_failures{deployment=~"${deployment}"})`
        )
      },
      {
        name: "taskSuccessRate",
        query: rangeQuery(
          `rate(airflow_operator_successes{deployment=~"${deployment}"}${duration})`
        )
      },
      {
        name: "taskFailRate",
        query: rangeQuery(
          `rate(airflow_operator_failures{deployment=~"${deployment}"}${duration})`
        )
      }
    ],
    DEPLOYMENT_QUOTAS: [
      {
        name: "maxPods",
        query: query(
          `sum(kube_resourcequota{resource="pods", type="hard", release=~"${deployment}", resourcequota=~"${deployment}-resource-quota"})`
        )
      },
      {
        name: "cpuMax",
        query: query(
          `sum(kube_resourcequota{resource="limits.cpu", type="hard", release=~"${deployment}", resourcequota=~"${deployment}-resource-quota"})`
        )
      },
      {
        name: "memoryMax",
        query: query(
          `sum(kube_resourcequota{resource="limits.memory", type="hard", release=~"${deployment}", resourcequota=~"${deployment}-resource-quota"})`
        )
      },
      {
        name: "runningPods",
        query: query(
          `sum(kube_resourcequota{resource="pods", type="used", release=~"${deployment}", resourcequota=~"${deployment}-resource-quota"}) /
           sum(kube_resourcequota{resource="pods", type="hard", release=~"${deployment}", resourcequota=~"${deployment}-resource-quota"}) * 100`
        )
      },
      {
        name: "reservedCPU",
        query: query(
          `sum(kube_resourcequota{resource="limits.cpu", type="used", release=~"${deployment}", resourcequota=~"${deployment}-resource-quota"}) /
           sum(kube_resourcequota{resource="limits.cpu", type="hard", release=~"${deployment}", resourcequota=~"${deployment}-resource-quota"}) * 100`
        )
      },
      {
        name: "reservedMemory",
        query: query(
          `sum(kube_resourcequota{resource="limits.memory", type="used", release=~"${deployment}", resourcequota=~"${deployment}-resource-quota"}) /
           sum(kube_resourcequota{resource="limits.memory", type="hard", release=~"${deployment}", resourcequota=~"${deployment}-resource-quota"}) * 100`
        )
      }
    ],
    DEPLOYMENT_USAGE: [
      {
        name: "cpuUsage",
        query: rangeQuery(
          `label_replace(sum(rate(container_cpu_usage_seconds_total{deployment=~"${deployment}", component_name != "POD",image!="", container_name!="istio-proxy"}${duration})) by (pod_name, container_name, component_name, namespace, short_name)/  sum(container_spec_cpu_quota{deployment=~"${deployment}",  component_name != "POD",image!="", container_name!="istio-proxy"}/container_spec_cpu_period{deployment=~"${deployment}",  component_name != "POD",image!="", container_name!="istio-proxy"}) by (pod_name, container_name, component_name, namespace, short_name)*100,  "short_name",  "$1",  "pod_name",  "^${deployment}-(.*)$")`
        )
      },
      {
        name: "memoryUsage",
        query: rangeQuery(
          `container_memory_usage_bytes{deployment=~"${deployment}",component_name != "POD",image!="", container_name!="istio-proxy"} * 100 / container_spec_memory_limit_bytes{deployment=~"${deployment}",component_name != "POD",image!="", container_name!="istio-proxy"}`
        )
      },
      {
        name: "networkRx",
        query: rangeQuery(
          `rate(container_network_receive_bytes_total{component_name=~".*(${components})", deployment=~"${deployment}"}${duration})`
        )
      },
      {
        name: "networkTx",
        query: rangeQuery(
          `rate(container_network_transmit_bytes_total{component_name=~".*(${components})", deployment=~"${deployment}"}${duration})`
        )
      }
    ]
  };
}
