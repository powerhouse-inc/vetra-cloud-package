# Auto-Update for Cloud Environments

## Summary

Enable cloud environments to automatically receive new Docker image versions when the monorepo publishes a release. The monorepo CI sends a webhook to the cloud switchboard, which updates all environments that have auto-update enabled for the matching release channel. The existing gitops processor handles the rest.

## Architecture

### Trigger Flow

```
Monorepo CI publishes v6.0.0-dev.126
  -> POST /graphql/vetra-cloud-auto-update (webhook with shared secret)
    -> Subgraph finds environments with autoUpdate=true, channel="dev"
      -> Dispatches SET_IMAGE_TAG for each matching service
        -> Document status -> CHANGES_PENDING -> auto-approved -> CHANGES_PUSHED
          -> Processor generates values YAML with new imageTag
            -> Git push to k8s-hosting
              -> ArgoCD syncs -> pod rollout
```

### Why Webhook Over Polling

- Immediate: no 5-minute polling delay
- No unnecessary registry API calls
- Clear trigger chain for debugging
- Opt-in via secrets: if webhook URL isn't configured, nothing happens

## Document Model Changes

### State Schema Additions

Add to `VetraCloudEnvironmentState`:

```graphql
type VetraCloudEnvironmentState {
  # existing fields unchanged
  autoUpdate: Boolean
  autoUpdateChannel: String  # "dev" | "staging" | "latest"
}
```

Add `imageTag` to `VetraCloudEnvironmentService`:

```graphql
type VetraCloudEnvironmentService {
  type: VetraCloudEnvironmentServiceType!
  prefix: String
  enabled: Boolean!
  url: String
  status: VetraCloudEnvironmentServiceStatus!
  imageTag: String  # e.g. "v6.0.0-dev.125", defaults to channel name
}
```

### New Module: `auto_update`

Three operations:

1. **`TOGGLE_AUTO_UPDATE`**
   - Input: `{ enabled: Boolean! }`
   - Reducer: sets `state.autoUpdate = action.input.enabled`
   - Transitions status to `CHANGES_PENDING` if environment is deployed

2. **`SET_AUTO_UPDATE_CHANNEL`**
   - Input: `{ channel: String! }`
   - Reducer: sets `state.autoUpdateChannel = action.input.channel`
   - Transitions status to `CHANGES_PENDING` if environment is deployed

3. **`SET_IMAGE_TAG`**
   - Input: `{ serviceType: VetraCloudEnvironmentServiceType!, tag: String! }`
   - Reducer: finds matching service, sets `service.imageTag = action.input.tag`
   - Transitions status to `CHANGES_PENDING` if environment is deployed

## Processor Changes

### `generateValuesYaml()` in `gitops.ts`

Replace hardcoded `tag: dev` with per-service image tags:

```typescript
const switchboardService = environment.services.find(s => s.type === "SWITCHBOARD");
const connectService = environment.services.find(s => s.type === "CONNECT");

const switchboardTag = switchboardService?.imageTag ?? environment.autoUpdateChannel ?? "dev";
const connectTag = connectService?.imageTag ?? environment.autoUpdateChannel ?? "dev";
```

These values are interpolated into the YAML template where `tag: dev` is currently hardcoded.

### Auto-Approve for Auto-Update

When the processor sees a `SET_IMAGE_TAG` operation on an environment with `autoUpdate: true`, it should auto-transition from `CHANGES_PENDING` to `CHANGES_APPROVED` without manual intervention. This can be detected in `onOperations()` by checking the operation name.

## New Subgraph: `vetra-cloud-auto-update`

### Location

`subgraphs/vetra-cloud-auto-update/`

### GraphQL Schema

```graphql
type Mutation {
  notifyNewImageRelease(input: NewImageReleaseInput!): AutoUpdateResult!
}

input NewImageReleaseInput {
  tag: String!
  channel: String!
  images: [String!]!
  secret: String!
}

type AutoUpdateResult {
  updatedEnvironments: [String!]!
}
```

### Handler Logic

1. Validate `secret` against `AUTO_UPDATE_WEBHOOK_SECRET` env var. Reject if mismatch.
2. Query all vetra-cloud-environment documents from the reactor.
3. Filter for:
   - `autoUpdate === true`
   - `autoUpdateChannel === input.channel`
   - `status` is in a deployed state (READY, CHANGES_PENDING, CHANGES_APPROVED, CHANGES_PUSHED, DEPLOYING)
4. For each matching environment, for each enabled service whose type matches the images list (SWITCHBOARD, CONNECT):
   - Dispatch `SET_IMAGE_TAG` action with the new tag
5. Return list of updated environment document IDs.

### Authentication

The `secret` field in the mutation input is compared against `AUTO_UPDATE_WEBHOOK_SECRET` env var. This avoids needing HTTP header middleware — the subgraph handles auth at the GraphQL level.

## Monorepo CI Changes

### `publish-docker-images.yml`

Add job after `build`:

```yaml
notify-auto-update:
  name: Notify Cloud Auto-Update
  needs: build
  if: ${{ needs.build.outputs.tag != '' }}
  runs-on: ubuntu-latest
  steps:
    - name: Notify cloud switchboard
      env:
        TAG: ${{ needs.build.outputs.tag }}
        WEBHOOK_URL: ${{ secrets.CLOUD_AUTO_UPDATE_WEBHOOK_URL }}
        WEBHOOK_SECRET: ${{ secrets.CLOUD_AUTO_UPDATE_WEBHOOK_SECRET }}
      run: |
        if [ -z "$WEBHOOK_URL" ]; then
          echo "No webhook URL configured, skipping"
          exit 0
        fi
        CHANNEL=""
        if [[ "$TAG" == *"-dev."* ]]; then CHANNEL="dev"
        elif [[ "$TAG" == *"-staging."* ]]; then CHANNEL="staging"
        else CHANNEL="latest"; fi

        curl -sf -X POST "$WEBHOOK_URL" \
          -H "Content-Type: application/json" \
          -d "{\"query\":\"mutation { notifyNewImageRelease(input: { tag: \\\"${TAG}\\\", channel: \\\"${CHANNEL}\\\", images: [\\\"switchboard\\\", \\\"connect\\\"], secret: \\\"${WEBHOOK_SECRET}\\\" }) { updatedEnvironments } }\"}"
```

Opt-in: silently skips if secrets aren't configured.

## vetra.to UI Changes

### Overview Tab (`tabs/overview.tsx`)

Add an "Auto-Update" section below the existing service toggles:

- **Toggle**: "Auto-update images" — dispatches `TOGGLE_AUTO_UPDATE`
- **Channel selector**: Dropdown ("dev", "staging", "latest") — dispatches `SET_AUTO_UPDATE_CHANNEL`. Only visible when auto-update is enabled.
- **Image tags display**: For each enabled service, show current `imageTag` as read-only text. Useful for debugging.

## Implementation Order

1. Document model: add fields + operations + reducers
2. Processor: use `imageTag` in `generateValuesYaml()`, add auto-approve logic
3. Subgraph: `vetra-cloud-auto-update` with webhook handler
4. vetra.to UI: auto-update toggle and channel selector
5. Monorepo CI: add webhook notification step
6. Deploy and test with eager-frog environment

## Testing Strategy

- Unit tests for new reducers (TOGGLE_AUTO_UPDATE, SET_AUTO_UPDATE_CHANNEL, SET_IMAGE_TAG)
- Unit test for `generateValuesYaml()` with custom image tags
- Integration test: subgraph mutation triggers SET_IMAGE_TAG on matching environments
- E2E: trigger webhook, verify gitops values file updated with new tag
