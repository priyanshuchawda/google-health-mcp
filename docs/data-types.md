# Google Health data types

This table is the checked-in capability snapshot used by the generic MCP data tools. It was reviewed against [Google's data type catalog](https://developers.google.com/health/data-types) on 2026-11-27. The exact API methods and request/response schemas come from the official discovery documents tracked in [api-methods.json](../spec/api-methods.json).

The API version column marks beta-only data types; the generic read tool selects v4beta automatically for those entries. The operation list is authoritative for tool validation: reads and writes are checked per data type before a request is sent. Scope categories are shown for orientation; see Google's current documentation for their exact semantics. The food resource is a reference collection, not a personal meal log. This server does not infer native goals from this catalog. Google's calories guide and migration material describe basal metabolic/basal energy values differently, but this 44-entry catalog does not list a standalone `basal-energy-burned` record type. Google's [Health CLI](https://github.com/Google-Health-API/google-health-cli) lists basal energy as list/reconcile, which conflicts with the catalog and calories guide's statement that the API does not provide it as an independent data type. We keep it out of the supported registry pending authenticated live API verification. Basal energy and HRV/resting-heart-rate personal ranges appear in schema/rollup fields, not as standalone record types here.

| Slug                                  | API version | Kind     | Supported operations                                                                  | OAuth scope categories          |
| ------------------------------------- | ----------- | -------- | ------------------------------------------------------------------------------------- | ------------------------------- |
| `active-energy-burned`                | v4          | Interval | `list`, `reconcile`, `rollUp`, `dailyRollUp`                                          | activity_and_fitness            |
| `active-minutes`                      | v4          | Interval | `list`, `reconcile`, `rollUp`, `dailyRollUp`                                          | activity_and_fitness            |
| `active-zone-minutes`                 | v4          | Interval | `list`, `reconcile`, `rollUp`, `dailyRollUp`                                          | activity_and_fitness            |
| `activity-level`                      | v4          | Interval | `list`, `reconcile`                                                                   | activity_and_fitness            |
| `altitude`                            | v4          | Interval | `list`, `reconcile`, `rollUp`, `dailyRollUp`                                          | activity_and_fitness            |
| `blood-glucose`                       | v4          | Sample   | `list`, `get`, `reconcile`, `rollUp`, `dailyRollUp`                                   | health_metrics_and_measurements |
| `body-fat`                            | v4          | Sample   | `list`, `get`, `reconcile`, `rollUp`, `dailyRollUp`, `create`, `patch`, `batchDelete` | health_metrics_and_measurements |
| `calories-in-heart-rate-zone`         | v4          | Interval | `rollUp`, `dailyRollUp`                                                               | activity_and_fitness            |
| `core-body-temperature`               | v4          | Sample   | `list`, `get`, `reconcile`, `rollUp`, `dailyRollUp`                                   | health_metrics_and_measurements |
| `daily-heart-rate-variability`        | v4          | Daily    | `list`, `reconcile`                                                                   | health_metrics_and_measurements |
| `daily-heart-rate-zones`              | v4          | Daily    | `list`, `reconcile`                                                                   | health_metrics_and_measurements |
| `daily-oxygen-saturation`             | v4          | Daily    | `list`, `reconcile`                                                                   | health_metrics_and_measurements |
| `daily-respiratory-rate`              | v4          | Daily    | `list`, `reconcile`                                                                   | health_metrics_and_measurements |
| `daily-resting-heart-rate`            | v4          | Daily    | `list`, `reconcile`                                                                   | health_metrics_and_measurements |
| `daily-sleep-temperature-derivations` | v4          | Daily    | `list`, `reconcile`                                                                   | health_metrics_and_measurements |
| `daily-vo2-max`                       | v4          | Daily    | `list`, `reconcile`                                                                   | activity_and_fitness            |
| `distance`                            | v4          | Interval | `list`, `reconcile`, `rollUp`, `dailyRollUp`                                          | activity_and_fitness            |
| `electrocardiogram`                   | v4          | Session  | `list`                                                                                | ecg                             |
| `exercise`                            | v4          | Session  | `list`, `get`, `reconcile`, `create`, `patch`, `batchDelete`                          | activity_and_fitness            |
| `floors`                              | v4          | Interval | `reconcile`, `rollUp`, `dailyRollUp`                                                  | activity_and_fitness            |
| `food`                                | v4          | Food     | `list`, `get`                                                                         | nutrition                       |
| `food-measurement-unit`               | v4          | Food     | `list`, `get`                                                                         | nutrition                       |
| `heart-rate`                          | v4          | Sample   | `list`, `reconcile`, `rollUp`, `dailyRollUp`                                          | health_metrics_and_measurements |
| `heart-rate-variability`              | v4          | Sample   | `list`, `reconcile`                                                                   | health_metrics_and_measurements |
| `height`                              | v4          | Sample   | `list`, `get`, `reconcile`, `create`, `patch`, `batchDelete`                          | health_metrics_and_measurements |
| `hydration-log`                       | v4          | Session  | `list`, `get`, `reconcile`, `rollUp`, `dailyRollUp`, `create`, `patch`, `batchDelete` | nutrition                       |
| `irregular-rhythm-notification`       | v4          | Session  | `list`                                                                                | irn                             |
| `menstrual-period`                    | v4          | Interval | `create`, `patch`, `batchDelete`                                                      | reproductive_health             |
| `moods`                               | v4          | Sample   | `create`, `patch`, `batchDelete`                                                      | mindfulness                     |
| `nutrition-log`                       | v4          | Session  | `list`, `get`, `reconcile`, `rollUp`, `dailyRollUp`, `create`, `patch`, `batchDelete` | nutrition                       |
| `ovulation-test`                      | v4          | Sample   | `create`, `patch`, `batchDelete`                                                      | reproductive_health             |
| `oxygen-saturation`                   | v4          | Sample   | `list`, `reconcile`                                                                   | health_metrics_and_measurements |
| `respiratory-rate-sleep-summary`      | v4          | Sample   | `list`, `reconcile`                                                                   | health_metrics_and_measurements |
| `run-vo2-max`                         | v4          | Sample   | `list`, `reconcile`, `rollUp`, `dailyRollUp`                                          | activity_and_fitness            |
| `sedentary-period`                    | v4          | Interval | `list`, `reconcile`, `rollUp`, `dailyRollUp`                                          | activity_and_fitness            |
| `skin-temperature-sensors`            | v4beta      | Sample   | `list`                                                                                | health_metrics_and_measurements |
| `sleep`                               | v4          | Session  | `list`, `get`, `reconcile`, `create`, `patch`, `batchDelete`                          | sleep                           |
| `steps`                               | v4          | Interval | `list`, `reconcile`, `rollUp`, `dailyRollUp`                                          | activity_and_fitness            |
| `swim-lengths-data`                   | v4          | Interval | `list`, `reconcile`, `rollUp`, `dailyRollUp`                                          | activity_and_fitness            |
| `symptoms`                            | v4          | Sample   | `create`, `patch`, `batchDelete`                                                      | logged_symptoms                 |
| `time-in-heart-rate-zone`             | v4          | Interval | `list`, `reconcile`, `rollUp`, `dailyRollUp`                                          | activity_and_fitness            |
| `total-calories`                      | v4          | Interval | `rollUp`, `dailyRollUp`                                                               | activity_and_fitness            |
| `vo2-max`                             | v4          | Sample   | `list`, `reconcile`                                                                   | activity_and_fitness            |
| `weight`                              | v4          | Sample   | `list`, `get`, `reconcile`, `rollUp`, `dailyRollUp`, `create`, `patch`, `batchDelete` | health_metrics_and_measurements |
