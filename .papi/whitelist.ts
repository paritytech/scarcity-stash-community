// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Descriptor whitelist: keeps the generated @polkadot-api/descriptors
// package (and with it the single-file bundle) down to the entries the
// app uses. `papi generate` picks this file up automatically; add entries
// here BEFORE coding against new pallet surfaces, then `npm run
// chain:update`.

import type { PaseoAssetHubWhitelistEntry, PaseoPeopleWhitelistEntry } from '@polkadot-api/descriptors';

export const whitelist: (PaseoAssetHubWhitelistEntry | PaseoPeopleWhitelistEntry)[] = [
  // Asset Hub: the NFTs of an account (nfts/nfts.ts), and all three metadata
  // layers of each in one batched runtime call, which getInstanceDisplays of
  // @parity/product-sdk-nfts makes together with its ItemDefs read below.
  // metadata_batch also serves the mint flow's Item preview metadata, the
  // one place the app calls it itself (credits/preview.ts).
  'query.Scarcity.NftsByOwner',
  'api.ScarcityApi.metadata_batch',
  // Asset Hub: claim state, read by getClaims (credits/credits.ts)
  'query.NftClaims.CreditTrees',
  'query.NftClaims.ClaimedLeaves',
  // Asset Hub: how long a credit's tree stays, which is how long an NFT can be
  // minted from the credit (credits/credits.ts)
  'const.NftClaims.TreeTtl',
  // Asset Hub: the mint flow. The registered collections are read via
  // getClaimableCollections (collections/minters.ts), the preview asks the
  // runtime what a credit would mint into each (api NftClaimsApi.preview_mints,
  // credits/preview.ts), and the claim spends the credit (credits/claim.ts).
  'query.NftClaims.CollectionMinters',
  'query.Scarcity.Collections',
  // Asset Hub: the catalogue reads of @parity/product-sdk-nfts: the id space
  // it pages over, the item definitions (which getInstanceDisplays reads too,
  // for whether an NFT can move), and the two metadata layers it
  // merges into an item (getClaimableCollections / getCollectionItems).
  'query.Scarcity.NextCollectionId',
  'query.Scarcity.ItemDefs',
  'query.Scarcity.CollectionMetadata',
  'query.Scarcity.ItemMetadata',
  'api.NftClaimsApi.preview_mints',
  'tx.NftClaims.claim',
  // Asset Hub: the claimant's nonce, read once per mint (credits/claim.ts)
  'api.AccountNonceApi.account_nonce',
  // Asset Hub: gas for a claim (credits/gas.ts). The PGAS asset, an account's
  // PGAS balance, and the transfer that moves the person's daily PGAS from
  // product account 0 to the account that signs the claim.
  'const.Pgas.PgasAssetId',
  'query.Assets.Account',
  'tx.Assets.transfer_keep_alive',
  // People Chain: earned credits + proofs (credits/credits.ts), and the roots
  // the credit watch looks for (creditBlocksAt)
  'query.NftCredits.NftClaimCreditBlocks',
  'query.NftCredits.NftClaimCreditAwards',
  'query.NftCredits.NftClaimCreditRoots',
  'api.NftCreditsApi.nft_claim_credit_roots',
  'api.NftCreditsApi.nft_claim_credit_proofs',
];
