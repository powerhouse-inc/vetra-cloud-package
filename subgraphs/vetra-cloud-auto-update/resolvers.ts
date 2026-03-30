interface NewImageReleaseInput {
  tag: string;
  channel: string;
  images: string[];
  secret: string;
}

interface VetraCloudEnvironmentState {
  autoUpdate: boolean | null;
  autoUpdateChannel: string | null;
  status: string;
  services: Array<{
    type: string;
    enabled: boolean;
    imageTag: string | null;
  }>;
}

const DEPLOYED_STATUSES = new Set([
  "READY",
  "CHANGES_PENDING",
  "CHANGES_APPROVED",
  "CHANGES_PUSHED",
  "DEPLOYING",
]);

const SERVICE_TYPE_MAP: Record<string, string> = {
  switchboard: "SWITCHBOARD",
  connect: "CONNECT",
  fusion: "FUSION",
};

export function createResolvers(reactorClient: any) {
  return {
    Mutation: {
      notifyNewImageRelease: async (
        _: unknown,
        { input }: { input: NewImageReleaseInput },
      ) => {
        const expectedSecret = process.env.AUTO_UPDATE_WEBHOOK_SECRET;
        if (!expectedSecret || input.secret !== expectedSecret) {
          throw new Error("Unauthorized: invalid webhook secret");
        }

        console.info(
          `[auto-update] Received release notification: tag=${input.tag}, channel=${input.channel}, images=[${input.images.join(", ")}]`,
        );

        const updatedEnvironments: string[] = [];

        // Get all documents from the reactor
        const drives = await reactorClient.getDrives();
        for (const driveId of drives) {
          const drive = await reactorClient.get(driveId);
          if (!drive) continue;

          const nodes = (drive.state as any)?.global?.nodes ?? [];
          for (const node of nodes) {
            if (node.documentType !== "powerhouse/vetra-cloud-environment") continue;

            try {
              const doc = await reactorClient.get(node.id);
              if (!doc) continue;

              const state = (doc.state as any)?.global as VetraCloudEnvironmentState | undefined;
              if (!state) continue;

              if (!state.autoUpdate) continue;
              if (state.autoUpdateChannel !== input.channel) continue;
              if (!DEPLOYED_STATUSES.has(state.status)) continue;

              // Dispatch SET_IMAGE_TAG for each matching service
              for (const imageName of input.images) {
                const serviceType = SERVICE_TYPE_MAP[imageName.toLowerCase()];
                if (!serviceType) continue;

                const service = state.services.find(
                  (s) => s.type === serviceType && s.enabled,
                );
                if (!service) continue;

                // Skip if already on this tag
                if (service.imageTag === input.tag) continue;

                const action = {
                  id: `auto-update-${serviceType}-${Date.now()}`,
                  type: "SET_IMAGE_TAG",
                  input: {
                    serviceType,
                    tag: input.tag,
                  },
                  scope: "global",
                  timestampUtcMs: Date.now(),
                };

                await reactorClient.execute(node.id, "main", [action] as any);
                console.info(
                  `[auto-update] Updated ${serviceType} to ${input.tag} for ${node.id}`,
                );
              }

              updatedEnvironments.push(node.id);
            } catch (err) {
              console.error(
                `[auto-update] Failed to update ${node.id}: ${String(err)}`,
              );
            }
          }
        }

        console.info(
          `[auto-update] Updated ${updatedEnvironments.length} environment(s)`,
        );

        return { updatedEnvironments };
      },
    },
  };
}
