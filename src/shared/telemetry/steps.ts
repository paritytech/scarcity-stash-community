// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The step a submission's status is recorded as, the same in every journey
// that signs and watches a transaction.

import type { SubmitStatus } from '@/shared/chain/submit';

export const statusStep = (status: SubmitStatus): string => (status === 'inBlock' ? 'in block' : status);
