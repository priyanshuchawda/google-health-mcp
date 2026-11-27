# Google Health data types

This table is the checked-in capability snapshot used by the generic MCP data tools. It was reviewed against [Google's data type catalog](https://developers.google.com/health/data-types) on 2026-11-27. The exact API methods and request/response schemas come from the official discovery documents tracked in [api-methods.json](../spec/api-methods.json).

The operation list is authoritative for tool validation: reads and writes are checked per data type before a request is sent. Scope categories are shown for orientation; see Google's current documentation for their exact semantics. The food resource is a reference collection, not a personal meal log. This server does not infer native goals from this catalog.

| Slug                                  | Kind     | Supported operations                                                                  | OAuth scope categories          |
| ------------------------------------- | -------- | ------------------------------------------------------------------------------------- | ------------------------------- |
| `active-energy-burned`                | Interval | `list`, `reconcile`, `rollUp`, `dailyRollUp`                                          | activity_and_fitness            |
| `active-minutes`                      | Interval | `list`, `reconcile`, `rollUp`, `dailyRollUp`                                          | activity_and_fitness            |
| `active-zone-minutes`                 | Interval | `list`, `reconcile`, `rollUp`, `dailyRollUp`                                          | activity_and_fitness            |
| `activity-level`                      | Interval | `list`, `reconcile`                                                                   | activity_and_fitness            |
| `altitude`                            | Interval | `list`, `reconcile`, `rollUp`, `dailyRollUp`                                          | activity_and_fitness            |
| `blood-glucose`                       | Sample   | `list`, `get`, `reconcile`, `rollUp`, `dailyRollUp`                                   | health_metrics_and_measurements |
| `body-fat`                            | Sample   | `list`, `get`, `reconcile`, `rollUp`, `dailyRollUp`, `create`, `patch`, `batchDelete` | health_metrics_and_measurements |
| `calories-in-heart-rate-zone`         | Interval | `rollUp`, `dailyRollUp`                                                               | activity_and_fitness            |
| `core-body-temperature`               | Sample   | `list`, `get`, `reconcile`, `rollUp`, `dailyRollUp`                                   | health_metrics_and_measurements |
| `daily-heart-rate-variability`        | Daily    | `list`, `reconcile`                                                                   | health_metrics_and_measurements |
| `daily-heart-rate-zones`              | Daily    | `list`, `reconcile`                                                                   | health_metrics_and_measurements |
| `daily-oxygen-saturation`             | Daily    | `list`, `reconcile`                                                                   | health_metrics_and_measurements |
| `daily-respiratory-rate`              | Daily    | `list`, `reconcile`                                                                   | health_metrics_and_measurements |
| `daily-resting-heart-rate`            | Daily    | `list`, `reconcile`                                                                   | health_metrics_and_measurements |
| `daily-sleep-temperature-derivations` | Daily    | `list`, `reconcile`                                                                   | health_metrics_and_measurements |
| `daily-vo2-max`                       | Daily    | `list`, `reconcile`                                                                   | activity_and_fitness            |
| `distance`                            | Interval | `list`, `reconcile`, `rollUp`, `dailyRollUp`                                          | activity_and_fitness            |
| `electrocardiogram`                   | Session  | `list`                                                                                | ecg                             |
| `exercise`                            | Session  | `list`, `get`, `reconcile`, `create`, `patch`, `batchDelete`                          | activity_and_fitness            |
| `floors`                              | Interval | `reconcile`, `rollUp`, `dailyRollUp`                                                  | activity_and_fitness            |
| `food`                                | Food     | `list`, `get`                                                                         | nutrition                       |
| `food-measurement-unit`               | Food     | `list`, `get`                                                                         | nutrition                       |
| `heart-rate`                          | Sample   | `list`, `reconcile`, `rollUp`, `dailyRollUp`                                          | health_metrics_and_measurements |
| `heart-rate-variability`              | Sample   | `list`, `reconcile`                                                                   | health_metrics_and_measurements |
| `height`                              | Sample   | `list`, `get`, `reconcile`, `create`, `patch`, `batchDelete`                          | health_metrics_and_measurements |
| `hydration-log`                       | Session  | `list`, `get`, `reconcile`, `rollUp`, `dailyRollUp`, `create`, `patch`, `batchDelete` | nutrition                       |
| `irregular-rhythm-notification`       | Session  | `list`                                                                                | irn                             |
| `menstrual-period`                    | Interval | `create`, `patch`, `batchDelete`                                                      | reproductive_health             |
| `moods`                               | Sample   | `create`, `patch`, `batchDelete`                                                      | mindfulness                     |
| `nutrition-log`                       | Session  | `list`, `get`, `reconcile`, `rollUp`, `dailyRollUp`, `create`, `patch`, `batchDelete` | nutrition                       |
| `ovulation-test`                      | Sample   | `create`, `patch`, `batchDelete`                                                      | reproductive_health             |
| `oxygen-saturation`                   | Sample   | `list`, `reconcile`                                                                   | health_metrics_and_measurements |
| `respiratory-rate-sleep-summary`      | Sample   | `list`, `reconcile`                                                                   | health_metrics_and_measurements |
| `run-vo2-max`                         | Sample   | `list`, `reconcile`, `rollUp`, `dailyRollUp`                                          | activity_and_fitness            |
| `sedentary-period`                    | Interval | `list`, `reconcile`, `rollUp`, `dailyRollUp`                                          | activity_and_fitness            |
| `skin-temperature-sensors`            | Sample   | `list`                                                                                | health_metrics_and_measurements |
| `sleep`                               | Session  | `list`, `get`, `reconcile`, `create`, `patch`, `batchDelete`                          | sleep                           |
| `steps`                               | Interval | `list`, `reconcile`, `rollUp`, `dailyRollUp`                                          | activity_and_fitness            |
| `swim-lengths-data`                   | Interval | `list`, `reconcile`, `rollUp`, `dailyRollUp`                                          | activity_and_fitness            |
| `symptoms`                            | Sample   | `create`, `patch`, `batchDelete`                                                      | logged_symptoms                 |
| `time-in-heart-rate-zone`             | Interval | `list`, `reconcile`, `rollUp`, `dailyRollUp`                                          | activity_and_fitness            |
| `total-calories`                      | Interval | `rollUp`, `dailyRollUp`                                                               | activity_and_fitness            |
| `vo2-max`                             | Sample   | `list`, `reconcile`                                                                   | activity_and_fitness            |
| `weight`                              | Sample   | `list`, `get`, `reconcile`, `rollUp`, `dailyRollUp`, `create`, `patch`, `batchDelete` | health_metrics_and_measurements |
