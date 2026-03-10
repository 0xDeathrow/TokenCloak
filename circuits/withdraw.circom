pragma circom 2.1.6;

include "node_modules/circomlib/circuits/poseidon.circom";

/*
 * TokenCloak Withdraw Circuit
 *
 * Proves: "I know a nullifier and secret such that:
 *   1. commitment = Poseidon(nullifier, secret) is a leaf in the Merkle tree
 *   2. The Merkle tree has the given root
 *   3. The nullifier_hash = Poseidon(nullifier) matches the public input"
 *
 * Without revealing which leaf is mine (zero knowledge).
 *
 * Public inputs:  root, nullifier_hash, recipient
 * Private inputs: nullifier, secret, pathElements[LEVELS], pathIndices[LEVELS]
 */

// Merkle tree depth — 2^20 = 1,048,576 possible deposits
// Using 20 levels for good anonymity set
template MerkleTreeChecker(levels) {
    signal input leaf;
    signal input root;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // Compute root from leaf + path
    component hashers[levels];
    signal computedPath[levels + 1];
    computedPath[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        hashers[i] = Poseidon(2);

        // If pathIndices[i] == 0, leaf is on the left
        // If pathIndices[i] == 1, leaf is on the right
        // Constrain pathIndices to be 0 or 1
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        // left = (1 - pathIndices[i]) * computedPath[i] + pathIndices[i] * pathElements[i]
        // right = pathIndices[i] * computedPath[i] + (1 - pathIndices[i]) * pathElements[i]
        hashers[i].inputs[0] <== computedPath[i] + pathIndices[i] * (pathElements[i] - computedPath[i]);
        hashers[i].inputs[1] <== pathElements[i] + pathIndices[i] * (computedPath[i] - pathElements[i]);

        computedPath[i + 1] <== hashers[i].out;
    }

    // Verify computed root matches the public root
    root === computedPath[levels];
}

template Withdraw(levels) {
    // Public inputs
    signal input root;
    signal input nullifierHash;
    signal input recipient; // Not used in constraints, but prevents front-running

    // Private inputs
    signal input nullifier;
    signal input secret;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // 1. Compute commitment = Poseidon(nullifier, secret)
    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs[0] <== nullifier;
    commitmentHasher.inputs[1] <== secret;

    // 2. Compute nullifier hash = Poseidon(nullifier)
    component nullifierHasher = Poseidon(1);
    nullifierHasher.inputs[0] <== nullifier;

    // 3. Verify nullifier hash matches public input
    nullifierHash === nullifierHasher.out;

    // 4. Verify the commitment is in the Merkle tree
    component tree = MerkleTreeChecker(levels);
    tree.leaf <== commitmentHasher.out;
    tree.root <== root;

    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }

    // 5. recipient is a public input — including it in the circuit
    // prevents front-running (someone can't change the recipient address
    // by replacing the withdrawal transaction)
    signal recipientSquare;
    recipientSquare <== recipient * recipient;
}

// Main component: 5-level Merkle tree (32 deposit capacity, matches on-chain)
component main {public [root, nullifierHash, recipient]} = Withdraw(5);
