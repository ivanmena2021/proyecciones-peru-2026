const CONFIG = require('../config');

/**
 * Bias Correction Module
 *
 * Corrects for differential counting speed between urban and rural mesas.
 * Urban mesas are counted faster, creating a pro-urban bias in early results.
 *
 * Uses sub-stratification + Bayesian shrinkage.
 */

/**
 * Compute bias-corrected vote share for a department.
 *
 * @param {Object} deptData - { urbanMesas, ruralMesas, allMesas }
 *   Each mesa: { votes: Map<partyCode, count>, totalValid, electores }
 * @param {Object} frameDeptInfo - { urbanTotal, ruralTotal } from frame
 * @param {string[]} partyCodes - list of party codes to estimate
 * @returns {Map<partyCode, number>} corrected vote share per party
 */
function computeCorrectedShares(deptData, frameDeptInfo, partyCodes) {
  const { urbanMesas, ruralMesas } = deptData;
  const { urbanTotal, ruralTotal } = frameDeptInfo;

  // If we have no data at all, return null
  if (urbanMesas.length === 0 && ruralMesas.length === 0) {
    return null;
  }

  // Compute raw vote shares per sub-stratum
  const urbanShares = computeSubStratumShares(urbanMesas, partyCodes);
  const ruralShares = computeSubStratumShares(ruralMesas, partyCodes);

  // Overall department shares (used as prior for shrinkage)
  const allMesas = [...urbanMesas, ...ruralMesas];
  const overallShares = computeSubStratumShares(allMesas, partyCodes);

  // Apply shrinkage to rural shares if sample is small
  const correctedRuralShares = new Map();
  for (const pc of partyCodes) {
    const directRural = ruralShares.get(pc) || 0;
    const prior = overallShares.get(pc) || 0;

    if (ruralMesas.length >= CONFIG.MIN_SUBSAMPLE_FOR_DIRECT) {
      // Enough data: use direct estimate
      correctedRuralShares.set(pc, directRural);
    } else {
      // Shrinkage: blend with department-wide average
      const lambda = ruralMesas.length / (ruralMesas.length + CONFIG.SHRINKAGE_KAPPA);
      correctedRuralShares.set(pc, lambda * directRural + (1 - lambda) * prior);
    }
  }

  // Compute population weights for urban/rural
  // w_U = N_urban * avgVotes_urban / total
  const avgVotesUrban = urbanMesas.length > 0
    ? urbanMesas.reduce((s, m) => s + m.totalValid, 0) / urbanMesas.length
    : 0;
  const avgVotesRural = ruralMesas.length > 0
    ? ruralMesas.reduce((s, m) => s + m.totalValid, 0) / ruralMesas.length
    : avgVotesUrban; // fallback

  const totalWeightedVotes = urbanTotal * avgVotesUrban + ruralTotal * avgVotesRural;

  if (totalWeightedVotes === 0) {
    return overallShares; // fallback
  }

  const wUrban = (urbanTotal * avgVotesUrban) / totalWeightedVotes;
  const wRural = (ruralTotal * avgVotesRural) / totalWeightedVotes;

  // Combine: R_d,c = w_U * R_d,U,c + w_R * R_d,R,c
  const correctedShares = new Map();
  for (const pc of partyCodes) {
    const urbanShare = urbanShares.get(pc) || 0;
    const ruralShare = correctedRuralShares.get(pc) || 0;
    correctedShares.set(pc, wUrban * urbanShare + wRural * ruralShare);
  }

  return correctedShares;
}

/**
 * Compute vote shares within a sub-stratum (ratio estimator).
 * R_{s,c} = sum(Y_{m,c}) / sum(Y_m)
 */
function computeSubStratumShares(mesas, partyCodes) {
  const shares = new Map();
  if (mesas.length === 0) {
    for (const pc of partyCodes) shares.set(pc, 0);
    return shares;
  }

  const totalValid = mesas.reduce((s, m) => s + m.totalValid, 0);
  if (totalValid === 0) {
    for (const pc of partyCodes) shares.set(pc, 0);
    return shares;
  }

  for (const pc of partyCodes) {
    const totalVotes = mesas.reduce((s, m) => s + (m.votes.get(pc) || 0), 0);
    shares.set(pc, totalVotes / totalValid);
  }

  return shares;
}

/**
 * Get urban/rural mesa counts from frame for a department.
 */
function getUrbanRuralTotals(frameBuilder, deptCode) {
  const { urban, rural } = frameBuilder.getUrbanRuralSplit(deptCode);
  return {
    urbanTotal: urban.length,
    ruralTotal: rural.length
  };
}

module.exports = {
  computeCorrectedShares,
  computeSubStratumShares,
  getUrbanRuralTotals
};
