import { type BaseSubgraph } from "@powerhousedao/reactor-api";
import { addFile } from "document-drive";
import {
  actions,
  type SetEnvironmentNameInput,
  type EnableServiceInput,
  type DisableServiceInput,
  type AddPackageInput,
  type RemovePackageInput,
  type StartInput,
  type StopInput,
  type VetraCloudEnvironmentDocument,
} from "../../document-models/vetra-cloud-environment/index.js";
import { setName } from "document-model";

export const getResolvers = (subgraph: BaseSubgraph): Record<string, unknown> => {
  const reactor = subgraph.reactor;

  return {
    Query: {
      VetraCloudEnvironment: async () => {
        return {
          getDocument: async (args: { docId: string; driveId: string }) => {
            const { docId, driveId } = args;

            if (!docId) {
              throw new Error("Document id is required");
            }

            if (driveId) {
              const docIds = await reactor.getDocuments(driveId);
              if (!docIds.includes(docId)) {
                throw new Error(
                  `Document with id ${docId} is not part of ${driveId}`,
                );
              }
            }

            const doc =
              await reactor.getDocument<VetraCloudEnvironmentDocument>(docId);
            return {
              driveId: driveId,
              ...doc,
              ...doc.header,
              created: doc.header.createdAtUtcIso,
              lastModified: doc.header.lastModifiedAtUtcIso,
              state: doc.state.global,
              stateJSON: doc.state.global,
              revision: doc.header?.revision?.global ?? 0,
            };
          },
          getDocuments: async (args: { driveId: string }) => {
            const { driveId } = args;
            const docsIds = await reactor.getDocuments(driveId);
            const docs = await Promise.all(
              docsIds.map(async (docId) => {
                const doc =
                  await reactor.getDocument<VetraCloudEnvironmentDocument>(
                    docId,
                  );
                return {
                  driveId: driveId,
                  ...doc,
                  ...doc.header,
                  created: doc.header.createdAtUtcIso,
                  lastModified: doc.header.lastModifiedAtUtcIso,
                  state: doc.state.global,
                  stateJSON: doc.state.global,
                  revision: doc.header?.revision?.global ?? 0,
                };
              }),
            );

            return docs.filter(
              (doc) =>
                doc.header.documentType ===
                "powerhouse/vetra-cloud-environment",
            );
          },
        };
      },
    },
    Mutation: {
      VetraCloudEnvironment_createDocument: async (
        _: unknown,
        args: { name: string; driveId?: string },
      ) => {
        const { driveId, name } = args;
        const document = await reactor.addDocument(
          "powerhouse/vetra-cloud-environment",
        );

        if (driveId) {
          await reactor.addAction(
            driveId,
            addFile({
              name,
              id: document.header.id,
              documentType: "powerhouse/vetra-cloud-environment",
            }),
          );
        }

        if (name) {
          await reactor.addAction(document.header.id, setName(name));
        }

        return document.header.id;
      },

      VetraCloudEnvironment_setEnvironmentName: async (
        _: unknown,
        args: { docId: string; input: SetEnvironmentNameInput },
      ) => {
        const { docId, input } = args;
        const doc =
          await reactor.getDocument<VetraCloudEnvironmentDocument>(docId);
        if (!doc) {
          throw new Error("Document not found");
        }

        const result = await reactor.addAction(
          docId,
          actions.setEnvironmentName(input),
        );

        if (result.status !== "SUCCESS") {
          throw new Error(
            result.error?.message ?? "Failed to setEnvironmentName",
          );
        }

        return true;
      },

      VetraCloudEnvironment_enableService: async (
        _: unknown,
        args: { docId: string; input: EnableServiceInput },
      ) => {
        const { docId, input } = args;
        const doc =
          await reactor.getDocument<VetraCloudEnvironmentDocument>(docId);
        if (!doc) {
          throw new Error("Document not found");
        }

        const result = await reactor.addAction(
          docId,
          actions.enableService(input),
        );

        if (result.status !== "SUCCESS") {
          throw new Error(result.error?.message ?? "Failed to enableService");
        }

        return true;
      },

      VetraCloudEnvironment_disableService: async (
        _: unknown,
        args: { docId: string; input: DisableServiceInput },
      ) => {
        const { docId, input } = args;
        const doc =
          await reactor.getDocument<VetraCloudEnvironmentDocument>(docId);
        if (!doc) {
          throw new Error("Document not found");
        }

        const result = await reactor.addAction(
          docId,
          actions.disableService(input),
        );

        if (result.status !== "SUCCESS") {
          throw new Error(result.error?.message ?? "Failed to disableService");
        }

        return true;
      },

      VetraCloudEnvironment_addPackage: async (
        _: unknown,
        args: { docId: string; input: AddPackageInput },
      ) => {
        const { docId, input } = args;
        const doc =
          await reactor.getDocument<VetraCloudEnvironmentDocument>(docId);
        if (!doc) {
          throw new Error("Document not found");
        }

        const result = await reactor.addAction(
          docId,
          actions.addPackage(input),
        );

        if (result.status !== "SUCCESS") {
          throw new Error(result.error?.message ?? "Failed to addPackage");
        }

        return true;
      },

      VetraCloudEnvironment_removePackage: async (
        _: unknown,
        args: { docId: string; input: RemovePackageInput },
      ) => {
        const { docId, input } = args;
        const doc =
          await reactor.getDocument<VetraCloudEnvironmentDocument>(docId);
        if (!doc) {
          throw new Error("Document not found");
        }

        const result = await reactor.addAction(
          docId,
          actions.removePackage(input),
        );

        if (result.status !== "SUCCESS") {
          throw new Error(result.error?.message ?? "Failed to removePackage");
        }

        return true;
      },

      VetraCloudEnvironment_start: async (
        _: unknown,
        args: { docId: string; input: StartInput },
      ) => {
        const { docId, input } = args;
        const doc =
          await reactor.getDocument<VetraCloudEnvironmentDocument>(docId);
        if (!doc) {
          throw new Error("Document not found");
        }

        const result = await reactor.addAction(docId, actions.start(input));

        if (result.status !== "SUCCESS") {
          throw new Error(result.error?.message ?? "Failed to start");
        }

        return true;
      },

      VetraCloudEnvironment_stop: async (
        _: unknown,
        args: { docId: string; input: StopInput },
      ) => {
        const { docId, input } = args;
        const doc =
          await reactor.getDocument<VetraCloudEnvironmentDocument>(docId);
        if (!doc) {
          throw new Error("Document not found");
        }

        const result = await reactor.addAction(docId, actions.stop(input));

        if (result.status !== "SUCCESS") {
          throw new Error(result.error?.message ?? "Failed to stop");
        }

        return true;
      },
    },
  };
};
