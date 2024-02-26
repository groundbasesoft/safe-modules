import { expect } from 'chai'
import { deployments, ethers, network } from 'hardhat'
import { MetaTransaction, SafeTransaction, buildSignatureBytes, calculateSafeTransactionHash, signHash } from '../../src/utils/execution'
import {
  buildUserOperationFromSafeUserOperation,
  buildSafeUserOpTransaction,
  signSafeOp,
  UserOperation,
  SafeUserOperation,
} from '../../src/utils/userOp'
import { chainId, timestamp } from '../utils/encoding'
import { Safe4337 } from '../../src/utils/safe'
import { BUNDLER_MNEMONIC, bundlerRpc, prepareAccounts, waitForUserOp } from '../utils/e2e'
import { JsonRpcSigner, Signer } from 'ethers'

class SafeOwnershipTreeNode {
  constructor(
    public value: Safe4337,
    public owners: (SafeOwnershipTreeNode | SafeOwnershipTreeEoaNode)[],
  ) {}
}

class SafeOwnershipTreeEoaNode {
  constructor(public value: Signer) {}
}

class SafeOwnershipTree {
  constructor(public root: SafeOwnershipTreeNode) {}
}

const walkTreeAndDeployAll = async (node: SafeOwnershipTreeNode, deployer: Signer) => {
  await node.value.deploy(deployer)

  for (const owner of node.owners) {
    if (owner instanceof SafeOwnershipTreeNode) {
      await walkTreeAndDeployAll(owner, deployer)
    }
  }
}

const isOwnedByEoasOnly = (node: SafeOwnershipTreeNode): boolean => {
  return node.owners.every((owner) => owner instanceof SafeOwnershipTreeEoaNode)
}

// An executor is a leaf node in the tree with EOAs as owners
// For the sake of simplicity, we assume that the executor is the first leaf node found, although
// it might be not the most optimal execution strategy
const getExecutorNode = (node: SafeOwnershipTreeNode): SafeOwnershipTreeNode => {
  if (isOwnedByEoasOnly(node)) {
    return node
  }

  for (const owner of node.owners) {
    if (owner instanceof SafeOwnershipTreeNode) {
      return getExecutorNode(owner)
    }
  }

  throw new Error('No executor node found')
}

const buildNestedSafeOp = async (
  safeTx: SafeTransaction,
  safe: SafeOwnershipTreeNode,
  executorSafe: SafeOwnershipTreeNode,
  entryPointAddress: string,
): SafeUserOperation => {
  if (safe.value.address === executorSafe.value.address) {
    return buildSafeUserOpTransaction(executorSafe.value.address, safeTx.to, safeTx.value, safeTx.data, 0, entryPointAddress, false, true)
  }

  const safeTxHash = calculateSafeTransactionHash(safe.value.address, safeTx, await chainId())

  const signatures = []
  for (const owner of safe.owners) {
    if (owner instanceof SafeOwnershipTreeEoaNode) {
      signatures.push(await signHash(owner.value, safeTxHash))
    } else {
      // Else we need to recursively sign the transaction
      // signatures.push(await buildNestedSafeOp(safeTx, owner, entryPointAddress))
    }
  }
}

describe('E2E - Nested Safes With An Execution Initiated by the Leaf Safe', () => {
  before(function () {
    if (network.name !== 'localhost') {
      this.skip()
    }
  })

  const setupTests = async () => {
    const { SafeModuleSetup, EntryPoint, HariWillibaldToken, Safe4337Module, SafeL2, SafeProxyFactory } = await deployments.run()
    const [user, user2] = await prepareAccounts(BUNDLER_MNEMONIC, 2)
    const bundler = bundlerRpc()

    const entryPoint = new ethers.Contract(EntryPoint.address, EntryPoint.abi, ethers.provider)
    const validator = await ethers.getContractAt('Safe4337Module', Safe4337Module.address)
    const token = await ethers.getContractAt('HariWillibaldToken', HariWillibaldToken.address)
    const proxyFactory = await ethers.getContractAt('SafeProxyFactory', SafeProxyFactory.address)
    const proxyCreationCode = await proxyFactory.proxyCreationCode()

    const leafSafe = new SafeOwnershipTreeNode(
      Safe4337.withSigner(user.address, {
        safeSingleton: SafeL2.address,
        entryPoint: EntryPoint.address,
        erc4337module: Safe4337Module.address,
        proxyFactory: SafeProxyFactory.address,
        safeModuleSetup: SafeModuleSetup.address,
        proxyCreationCode,
        chainId: Number(await chainId()),
      }),
      [new SafeOwnershipTreeEoaNode(user)],
    )
    const leafSafe2 = new SafeOwnershipTreeNode(
      Safe4337.withSigner(user2.address, {
        safeSingleton: SafeL2.address,
        entryPoint: EntryPoint.address,
        erc4337module: Safe4337Module.address,
        proxyFactory: SafeProxyFactory.address,
        safeModuleSetup: SafeModuleSetup.address,
        proxyCreationCode,
        chainId: Number(await chainId()),
      }),
      [new SafeOwnershipTreeEoaNode(user2)],
    )
    const nodeSafe = new SafeOwnershipTreeNode(
      Safe4337.withSigner(leafSafe.value.address, {
        safeSingleton: SafeL2.address,
        entryPoint: EntryPoint.address,
        erc4337module: Safe4337Module.address,
        proxyFactory: SafeProxyFactory.address,
        safeModuleSetup: SafeModuleSetup.address,
        proxyCreationCode,
        chainId: Number(await chainId()),
      }),
      [leafSafe],
    )
    const rootSafe = new SafeOwnershipTreeNode(
      Safe4337.withSigners([nodeSafe.value.address, leafSafe2.value.address], 2, {
        safeSingleton: SafeL2.address,
        entryPoint: EntryPoint.address,
        erc4337module: Safe4337Module.address,
        proxyFactory: SafeProxyFactory.address,
        safeModuleSetup: SafeModuleSetup.address,
        proxyCreationCode,
        chainId: Number(await chainId()),
      }),
      [nodeSafe, leafSafe2],
    )
    const tree = new SafeOwnershipTree(rootSafe)

    return {
      user,
      bundler,
      tree,
      validator,
      entryPoint,
      token,
    }
  }

  it('should execute a transaction for an existing Safe', async () => {
    const { user, bundler, tree, validator, entryPoint, token } = await setupTests()

    await walkTreeAndDeployAll(tree.root, user)
    const executor = getExecutorNode(tree.root)
    const rootSafe = tree.root.value
    console.log({ executor })

    await token.transfer(rootSafe.address, ethers.parseUnits('4.2', 18)).then((tx) => tx.wait())
    await user.sendTransaction({ to: executor.value.address, value: ethers.parseEther('0.5') }).then((tx) => tx.wait())

    expect(ethers.dataLength(await ethers.provider.getCode(rootSafe.address))).to.not.equal(0)
    expect(await token.balanceOf(rootSafe.address)).to.equal(ethers.parseUnits('4.2', 18))

    const safeTransaction: SafeTransaction = {
      to: await token.getAddress(),
      value: 0,
      data: token.interface.encodeFunctionData('transfer', [user.address, await token.balanceOf(rootSafe.address)]),
      operation: 0,
      safeTxGas: 0,
      baseGas: 0,
      gasPrice: 0,
      gasToken: ethers.ZeroAddress,
      refundReceiver: ethers.ZeroAddress,
      nonce: 0,
    }

    const safeOp = await buildNestedSafeOp(safeTransaction, tree.root, await entryPoint.getAddress())
    const signature = buildSignatureBytes([await signSafeOp(user, await validator.getAddress(), safeOp, await chainId())])
    const userOp = buildUserOperationFromSafeUserOperation({
      safeOp,
      signature,
    })

    await bundler.sendUserOperation(userOp, await entryPoint.getAddress())

    await waitForUserOp(userOp)
    expect(await token.balanceOf(rootSafe.address)).to.equal(0n)
  })

  // it('should deploy a new Safe and execute a transaction', async () => {
  //   const { user, bundler, tree, validator, entryPoint, token } = await setupTests()

  //   await token.transfer(rootSafe.address, ethers.parseUnits('4.2', 18)).then((tx) => tx.wait())
  //   await user.sendTransaction({ to: leafSafe.address, value: ethers.parseEther('0.5') }).then((tx) => tx.wait())

  //   expect(ethers.dataLength(await ethers.provider.getCode(safe.address))).to.equal(0)
  //   expect(await token.balanceOf(safe.address)).to.equal(ethers.parseUnits('4.2', 18))

  //   const validAfter = (await timestamp()) - 60
  //   const validUntil = validAfter + 300
  //   const safeOp = buildSafeUserOpTransaction(
  //     safe.address,
  //     await token.getAddress(),
  //     0,
  //     token.interface.encodeFunctionData('transfer', [user.address, await token.balanceOf(safe.address)]),
  //     await entryPoint.getNonce(safe.address, 0),
  //     await entryPoint.getAddress(),
  //     false,
  //     false,
  //     {
  //       initCode: safe.getInitCode(),
  //       validAfter,
  //       validUntil,
  //     },
  //   )
  //   const signature = buildSignatureBytes([await signSafeOp(user, await validator.getAddress(), safeOp, await chainId())])
  //   const userOp = buildUserOperationFromSafeUserOperation({
  //     safeOp,
  //     signature,
  //   })

  //   await bundler.sendUserOperation(userOp, await entryPoint.getAddress())

  //   await waitForUserOp(userOp)
  //   expect(ethers.dataLength(await ethers.provider.getCode(safe.address))).to.not.equal(0)
  //   expect(await token.balanceOf(safe.address)).to.equal(0)
  //   expect(await ethers.provider.getBalance(safe.address)).to.be.lessThan(ethers.parseEther('0.5'))
  // })
})
