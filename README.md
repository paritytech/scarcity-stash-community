> [!WARNING]
> The following is a proof-of-concept. This open source code is provided for research, experimentation, and developer education only. This code has not been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete features. Use at your own risk and obtain legal advice as appropriate - DYOR.

Parity doesn’t deploy the code but may update it based on community feedback.

If you experience problems with any product or service that was built on or deployed from this code, you should contact the third party who deployed the code in its amended form, not Parity.

# Scarcity Stash

[![CI](https://github.com/paritytech/scarcity-stash-community/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/paritytech/scarcity-stash-community/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-GPL--3.0--only-blue)](./LICENSE)

Scarcity Stash is a reference implementation of a collectibles app. It runs inside a Polkadot host, which is an app that implements [Trinity (TrUAPI)](https://github.com/paritytech/trinity-user-agents). It reads collections and the player's NFTs from Asset Hub and draws every piece of each collection on a grid. It also mints an NFT from a credit the player was awarded on the People Chain, once half of the credit's lifetime is gone. On screen the app is called Collectibles.

The app has no backend and no indexer. Chain reads go through the host's connections, and the host signs every transaction. The code is React and TypeScript, and `npm run build` writes the whole app to one `index.html`.

## What it does

### Collections

The grid lists the collections that `getApprovedCollections` of [`@parity/product-sdk-nfts`](https://github.com/paritytech/product-sdk/tree/main/product-sdk/packages/nfts) returns for the network, and any other collection the player holds an NFT from. The app reads every item of a listed collection with `getCollectionItems` and the collection names with `getClaimableCollections`. On the grid an item is a piece. A piece the player does not hold is a grey dot, and the app does not show or search its name. A collection registered for claims with more than 600 items is not read whole, and the grid then shows only the pieces the player holds from it.

### NFTs

The player's NFTs are in a host NFT purse with the name `stash`, which the app creates when the player has none (`src/entities/nfts/stashPurse.ts`). The app asks the host for the public keys of the purse's accounts that hold an NFT (`queryPurse`). It then reads `Scarcity.NftsByOwner` for those accounts and the metadata of each NFT with `getInstanceDisplays`, both at the same block.

### Pictures

An item's `manifest` metadata value is the CID of a JSON document, and that document has the CID of the item's thumbnail. The app asks the host's preimage lookup and the network's Levity (Bulletin) IPFS gateway for the bytes at the same time. It checks the bytes against the CID before it parses or draws them, and stores verified bytes in IndexedDB.

### Credits

The `NftCredits` pallet awards credits on the People Chain. The app reads the credits of one account with `getClaims`. That account is product account 1 of `dim2.<tld>` (Jollity in the code), and the host returns it from `getProductAccount`.

The app draws each credit at the piece that the runtime API `NftClaimsApi.preview_mints` returns for the credit and its collection. The collection is the newest one the player selected for the credit in Jollity, which keeps its selections in its own host storage under `jollity.chest`. Without a selection it is the player's top favourite, else an approved collection derived from the credit's hash (`src/entities/credits/selections.ts`). The app mints an NFT from a credit only after it has read the stored selections.

### Minting

An NFT can be minted from a credit until Asset Hub removes the credit's tree, `NftClaims.TreeTtl` seconds after the tree's time. The app has no mint button: it starts a mint itself once half of that lifetime is gone, the root of the credit's tree is on Asset Hub and its leaf is unclaimed (`src/features/holdings/mint.ts`). A younger credit stays a credit. For a mint the app creates a new account in the stash purse with `createItems` and submits `NftClaims.claim` with that account as `mint_to`. The host signs the claim as Jollity's account. Mints run one at a time with one credit per transaction, and each NFT is minted into an account of its own.

The account that signs a claim pays its fee in PGAS when it holds enough, and in PAS otherwise. When that account holds less than three claims' fees, the app transfers PGAS to it from this product's account 0. If account 0 holds too little, the app first asks the host to allocate the player's PGAS allowance to account 0 with `requestResourceAllocation` (`src/entities/credits/gas.ts`).

### Refreshing

The app lists the purse's accounts every 5 seconds and reads the NFTs and the credits every 30 seconds. It also reads again after a mint and when a new block changes the credits' state on either chain (`src/features/holdings/sync.ts`). The records of the last grid drawn are saved in host storage, and the next start reads them before it draws the first frame and before the first chain read.

## Where the NFTs are held

Running this code mints NFTs into a purse that belongs to this product in the host. The host derives the key pair of every purse account from the player's recovery phrase on the hard path `//nft//<purse>//<installation>//<index>`, as the [NFT purses](https://github.com/paritytech/trinity-user-agents#nft-purses) section of the host's README describes. The page holds no private key. With the recovery phrase, the purse id and the installation id, the same key pairs can be derived outside this app.

## What it does not do

- It does not transfer or burn NFTs.
- It does not run outside a host. In a browser tab the page shows one notice and connects to no chain.
- On a host without the NFT purse API it shows collections and credits, and it mints nothing.

## What has to exist

### A host

The app needs a host that serves the NFT purse API. It calls the host through `@parity/product-sdk-host` and `@parity/product-sdk-chain-client`.

### A network

The app's product id is the Nominality (DotNS) name the host runs the page under (`src/shared/chain/product.ts`). A name that ends in `.testnet` selects Previewnet, and any other name selects Paseo Next (`src/shared/chain/network.ts`). On either network the app uses Asset Hub and the People Chain. Their metadata is committed in `.papi/metadata`.

### Chain state

Asset Hub has to have the `Scarcity`, `NftClaims` and `Pgas` pallets, and the People Chain the `NftCredits` pallet. All four are in [paritytech/individuality-community](https://github.com/paritytech/individuality-community/tree/main/pallets). `.papi/whitelist.ts` lists every entry of them the app uses.

A collection is on the grid once its id is in the SDK's approved list for the network. An NFT can be minted into it from a credit once the collection's owner registered it for claims with `NftClaims.set_collection_minter`.

### The companion product

Credits are awarded to an account of another product, and the app claims them as that account. The code sets it to product account 1 of `dim2.<tld>` (`JOLLITY_LABEL` and `JOLLITY_ACCOUNT_INDEX` in `src/entities/credits/creditAccount.ts`). That product's manifest has to grant this product's label the `context` scope, so that the host signs a claim as that account ([Cross-Product Trust](https://github.com/paritytech/trinity-user-agents/blob/main/docs/design/product-manifest.md#cross-product-trust)).

The app also reads `jollity.chest` from that product's host storage, which needs its `storage` grant (`src/entities/credits/selections.ts`). The app saves its state in host storage through `src/shared/lib/stateStorage.ts`, under four keys: `pkt_collectibles_v1` has the records of the holdings, `pkt_collections_v1` the known collections and the favourites, `pkt_catalogues_v1` each collection's items, and `pkt_device_v1` the hashes already seen, the grid step, whether the player has turned a piece, and a random id for telemetry. Host storage is per device. A read that has not returned after 3 seconds is given up, and the app starts as on a first open.

## Run it

```bash
nvm use
npm install
npm run dev
```

After the install, `papi` generates the chain descriptors in `.papi/descriptors` from the committed metadata. It connects to no chain. `npm run dev` serves the app on port 5174 on every network interface.

In a browser tab the page shows one notice. To run it with chain data, open the dev server from a debug build of the Polkadot app and add a product id to the address, for example `localhost:5174?product_id=<name>.testnet`. The Polkadot app's iOS and Android sources are in `hosts/` of [paritytech/trinity-user-agents](https://github.com/paritytech/trinity-user-agents), and the steps for each device are in [Open a product from a dev server on a phone](https://github.com/paritytech/trinity-user-agents/blob/main/docs/dev-server-on-a-phone.md).

A player whose account holds no credits and no NFTs sees every approved collection with all of its pieces missing, and a card reading "Your collection starts with a game". Credits come only from playing Jollity; the app has no way to request them.

## Checks and build

```bash
npm run check
npm run build
```

`npm run check` runs the type check, ESLint, Stylelint, the Prettier check, knip and the tests. `npm run build` writes `dist/index.html`. CI runs both on every pull request (`.github/workflows/ci.yml`).

`npm run chain:update` fetches the chains' current metadata from the endpoints in `.papi/polkadot-api.json` and generates the descriptors again. The descriptors contain only the entries in `.papi/whitelist.ts`. Add an entry there before you use a new storage item, call or runtime API.

## Code layout

- `src/app/App.tsx` picks the screen and passes each chain read to the grid.
- `src/features/grid` is the screen. `model/` computes where each piece sits and `engine/` draws it on a canvas.
- `src/features/holdings` reads the NFTs and credits again as the chain changes (`sync.ts`) and mints (`mint.ts`).
- `src/entities` has one folder for each kind of data: `player`, `art`, `collections`, `nfts`, `credits`.
- `src/shared` has the chain connections and transaction submission (`chain`), content fetching by CID (`host`), `telemetry`, `lib` and `ui`.

Imports go down these layers only: app, features, entities, shared. ESLint fails an import that goes up (`eslint.config.js`).

## Outside requests

Chain connections are the host's. The app fetches pictures and manifests from the network's Bulletin IPFS gateway (`IPFS_GATEWAY` in `src/shared/chain/network.ts`) after it asks the host for the `Remote` permission for that domain. `src/app/main.tsx` loads the Inter and Manrope fonts from Google Fonts.

The default build contains no Sentry code, and the build fails if any reaches it (`vite.config.js`). A build made with `VITE_TELEMETRY=sentry` and a `VITE_SENTRY_DSN` sends records of the app's flows and its console warnings and errors to that Sentry project. Each record carries a random install id, a session id, the host's kind, the product's name and the network and, where the browser exposes them, the system and its version, the screen size, CPU cores, memory, connection type and phone model. A mint's records also carry the credit, the collection, the transaction and block hashes, the NFT's instance and item, and the address of the account the NFT goes to. A failure or a stall also sends a replay of the screen before it, with text, inputs and media masked. The app sends them only inside a host, after the host granted the `Remote` permission for the DSN's domain (`src/shared/telemetry`).

## Hosting the build

`npm run build` produces a single static `dist/index.html`. It runs only inside a host, which opens it under its DotNS name, through a gateway name such as `<name>.paseo.li`, or from a dev server (`src/shared/chain/product.ts`). `bulletin-deploy.config.ts` has the name, description and icon of the product's manifest.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) and the [Code of Conduct](./CODE_OF_CONDUCT.md) first.

## Security

Before deploying it for real use cases, you are responsible for:

- Reviewing the code yourself, we publish a reference, not a hardened production build
- Checking that the dependencies are up to date and free of known vulnerabilities
- Securing your own fork or deployment environment (keys, secrets, network configuration)
- Tracking the latest tagged release/commits for security fixes; older releases are not backported (exceptions might apply)

For Parity's security disclosure process, and Bug Bounty program, feel free to visit: https://parity.io/bug-bounty

## License

[GPL-3.0-only](./LICENSE) © Parity Technologies (UK) Ltd. The licence grants no trademark rights. The third-party packages in the build and their licences are listed in [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md).
