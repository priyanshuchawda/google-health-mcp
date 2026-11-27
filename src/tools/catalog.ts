export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface HealthToolDefinition {
  name: string;
  title: string;
  description: string;
  methodIds: readonly string[];
  annotations: ToolAnnotations;
  requiresProjectIam?: boolean;
}

const prefix = "health.users.dataTypes.dataPoints.";

export const toolCatalog: readonly HealthToolDefinition[] = Object.freeze([
  {
    name: "get_daily_health_summary",
    title: "Get a daily health summary",
    description:
      "Summarize one Google Health local calendar day using Google daily rollups and reconciled sleep sessions. Missing values remain null rather than becoming zero.",
    methodIds: [],
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "get_health_data",
    title: "Get Google Health data",
    description:
      "Read one Google Health data type as records, reconciled records, or aggregated rollups. Supply a bounded date range for manageable responses.",
    methodIds: ["list", "get", "reconcile", "rollUp", "dailyRollUp"].map(
      (name) => `${prefix}${name}`,
    ),
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "create_health_record",
    title: "Create a health record",
    description:
      "Create one manually supplied record only for a data type where Google documents create support. This writes to Google Health.",
    methodIds: [`${prefix}create`],
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "update_health_record",
    title: "Update a health record",
    description:
      "Update one exact record that belongs to the authenticated account and a Google Health data type where patch is supported.",
    methodIds: [`${prefix}patch`],
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "delete_health_records",
    title: "Delete health records",
    description:
      "Permanently delete only the exact record names supplied by the user. This action cannot be undone.",
    methodIds: [`${prefix}batchDelete`],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "get_health_account_data",
    title: "Get account health settings",
    description:
      "Read Google Health identity, profile, settings, paired devices, or irregular rhythm notification profile information.",
    methodIds: [
      "health.users.getIdentity",
      "health.users.getIrnProfile",
      "health.users.getProfile",
      "health.users.getSettings",
      "health.users.pairedDevices.get",
      "health.users.pairedDevices.list",
    ],
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "update_health_account_data",
    title: "Update health account settings",
    description:
      "Update only Google Health profile or settings fields supported by the official API. This changes account data.",
    methodIds: ["health.users.updateProfile", "health.users.updateSettings"],
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "export_exercise_tcx",
    title: "Export exercise route",
    description:
      "Export a supported exercise record as a TCX file from Google Health.",
    methodIds: [`${prefix}exportExerciseTcx`],
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "get_shared_health_link",
    title: "Read a shared health link",
    description:
      "Retrieve a manifest or an explicitly selected resource from a SMART Health Link. The link is a bearer capability; use only a link the user supplied.",
    methodIds: ["health.shl.m.getShlManifest", "health.shl.r.get"],
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "list_webhook_configuration",
    title: "List Google Health webhooks",
    description:
      "List subscriber endpoints or subscriptions in the configured Google Cloud project. Requires project IAM authorization and is disabled unless explicitly enabled.",
    methodIds: [
      "health.projects.subscribers.list",
      "health.projects.subscribers.subscriptions.list",
    ],
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    requiresProjectIam: true,
  },
  {
    name: "write_webhook_configuration",
    title: "Create or update Google Health webhooks",
    description:
      "Create or update a Google Health webhook subscriber or subscription. This can direct health-change notifications to an external endpoint and requires explicit project IAM setup.",
    methodIds: [
      "health.projects.subscribers.create",
      "health.projects.subscribers.patch",
      "health.projects.subscribers.subscriptions.create",
      "health.projects.subscribers.subscriptions.patch",
    ],
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    requiresProjectIam: true,
  },
  {
    name: "delete_webhook_configuration",
    title: "Delete Google Health webhooks",
    description:
      "Delete the exact webhook subscriber or subscription named by the user. Deleting a subscriber stops all notifications and can remove its child subscriptions.",
    methodIds: [
      "health.projects.subscribers.delete",
      "health.projects.subscribers.subscriptions.delete",
    ],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    requiresProjectIam: true,
  },
]);
