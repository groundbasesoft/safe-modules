// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

/**
 * @title A factory for creating unique signers for alternate signing schemes.
 */
interface IUniqueSignerFactory {
    /**
     * @notice Gets the unique signer address for the specified data.
     * @dev The unique signer address must be unique for some given data. The signer is not guaranteed to be created yet.
     * @param data The signer specific data.
     * @return signer The signer address.
     */
    function getSigner(bytes memory data) external view returns (address signer);

    /**
     * @notice Create a new unique signer for the specified data.
     * @dev The unique signer address must be unique for some given data. This must not revert if the unique owner already exists.
     * @param data The signer specific data.
     * @return signer The signer address.
     */
    function createSigner(bytes memory data) external returns (address signer);

    /**
     * @notice Verifies a signature for the specified address without deploying it.
     * @dev This must be equivalent to first deploying the signer with the factory, and then verifying the signature
     * with it directly: `factory.createSigner(signerData).isValidSignature(data, signature)`
     *
     * @param data The data whose signature should be verified.
     * @param signature The signature bytes.
     * @param signerData The signer data to verify signature for.
     * @return magicValue Returns `isValidSignatureFor.selector` when the signature is valid. Reverting or returning any other value implies an invalid signature.
     */
    function isValidSignatureFor(
        bytes calldata data,
        bytes calldata signature,
        bytes calldata signerData
    ) external view returns (bytes4 magicValue);
}
