import { Deferrable, defineReadOnly } from '@ethersproject/properties'
import { Provider, TransactionRequest, TransactionResponse } from '@ethersproject/providers'
import { Signer } from '@ethersproject/abstract-signer'
import { EntryPointFactoryContractV100 } from '@biconomy/ethers-lib'
import { ethers } from 'ethers'
import { BigNumber, Bytes } from 'ethers'
import { ERC4337EthersProvider } from './ERC4337EthersProvider'
import { ClientConfig } from './ClientConfig'
import { HttpRpcClient } from './HttpRpcClient'
import { UserOperation } from '@biconomy/core-types'
import { Logger } from '@biconomy/common'
import { BaseAccountAPI } from './BaseAccountAPI'
import { ClientMessenger } from 'messaging-sdk'
import WebSocket from 'isomorphic-ws'
export class ERC4337EthersSigner extends Signer {
  // TODO: we have 'erc4337provider', remove shared dependencies or avoid two-way reference
  private logger = new Logger()
  constructor(
    readonly config: ClientConfig,
    readonly originalSigner: Signer,
    readonly erc4337provider: ERC4337EthersProvider,
    readonly httpRpcClient: HttpRpcClient,
    readonly smartAccountAPI: BaseAccountAPI
  ) {
    super()
    defineReadOnly(this, 'provider', erc4337provider)
  }

  address?: string

  // This one is called by Contract. It signs the request and passes in to Provider to be sent.
  async sendTransaction(
    transaction: TransactionRequest,
    walletDeployOnly = false,
    engine?: any // EventEmitter
  ): Promise<TransactionResponse> {
    const socketServerUrl = this.config.socketServerUrl

    const clientMessenger = new ClientMessenger(socketServerUrl, WebSocket)

    if (!clientMessenger.socketClient.isConnected()) {
      try {
        await clientMessenger.connect()
        this.logger.log('socket connection success', { socketServerUrl })
      } catch (err) {
        this.logger.error('socket connection failure', err)
      }
    }

    this.logger.log('received transaction ', transaction)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const customData: any = transaction.customData
    this.logger.log('customData', customData)

    // customise gasLimit help dapps to supply gasLimit of their choice
    if (customData && (customData.isBatchedToMultiSend || !customData.isDeployed)) {
      if (customData.appliedGasLimit) {
        transaction.gasLimit = customData.appliedGasLimit
        this.logger.log('gaslimit applied from custom data...', transaction.gasLimit)
      }
    }

    delete transaction.customData

    let userOperation: UserOperation
    if (walletDeployOnly === true) {
      userOperation = await this.smartAccountAPI.createSignedUserOp({
        target: [''],
        data: [''],
        value: [0],
        gasLimit: [21000]
      })
    } else {
      // Removing populate transaction all together
      // const tx: TransactionRequest = await this.populateTransaction(transaction)

      this.verifyAllNecessaryFields(transaction)

      userOperation = await this.smartAccountAPI.createSignedUserOp({
        target: transaction.to ? [transaction.to] :  [ethers.constants.AddressZero],
        data: transaction.data?.toString() ? [transaction.data?.toString()]: ['0x'],
        value: transaction.value ? [transaction.value] : [0],
        gasLimit: transaction.gasLimit
      })
    }
    this.logger.log('signed userOp ', userOperation)

    let bundlerServiceResponse: any

    try {
      bundlerServiceResponse = await this.httpRpcClient.sendUserOpToBundler(userOperation)
      this.logger.log('bundlerServiceResponse', bundlerServiceResponse)
    } catch (error) {
      // console.error('sendUserOpToBundler failed', error)
      throw this.unwrapError(error)
    }

    if (clientMessenger && clientMessenger.socketClient.isConnected()) {
      clientMessenger.createTransactionNotifier(bundlerServiceResponse.transactionId, {
        onHashGenerated: async (tx: any) => {
          if (tx) {
            const txHash = tx.transactionHash
            const txId = tx.transactionId
            this.logger.log('Tx Hash generated message received at client', {
              transactionId: txId,
              hash: txHash
            })
            engine &&
              engine.emit('txHashGenerated', {
                id: tx.transactionId,
                hash: tx.transactionHash,
                msg: 'txn hash generated'
              })
          }
        },
        onHashChanged: async (tx: any) => {
          if (tx) {
            const txHash = tx.transactionHash
            const txId = tx.transactionId
            this.logger.log('Tx Hash changed message received at client', {
              transactionId: txId,
              hash: txHash
            })
            engine &&
              engine.emit('txHashChanged', {
                id: tx.transactionId,
                hash: tx.transactionHash,
                msg: 'txn hash changed'
              })
          }
        },
        onError: async (tx: any) => {
          if (tx) {
            this.logger.error('Error message received at client', tx)
            const err = tx.error
            const txId = tx.transactionId
            clientMessenger.unsubscribe(txId)
            // event emitter
            engine &&
              engine.emit('error', {
                id: tx.transactionId,
                error: err,
                msg: 'txn hash generated'
              })
          }
        }
      })
    }

    const transactionResponse = await this.erc4337provider.constructUserOpTransactionResponse(
      userOperation,
      bundlerServiceResponse.transactionId,
      engine
    )
    // const receipt = await transactionResponse.wait()
    // console.log('transactionResponse in sendTransaction', receipt)

    // TODO: handle errors - transaction that is "rejected" by bundler is _not likely_ to ever resolve its "wait()"
    return transactionResponse
  }

  async sendTransactionBatch(
    transactions: TransactionRequest[],
    engine?: any // EventEmitter
  ): Promise<TransactionResponse> {

    const socketServerUrl = this.config.socketServerUrl

    const clientMessenger = new ClientMessenger(socketServerUrl, WebSocket)

    if (!clientMessenger.socketClient.isConnected()) {
      try {
        await clientMessenger.connect()
        this.logger.log('socket connection success', { socketServerUrl })
      } catch (err) {
        this.logger.error('socket connection failure', err)
      }
    }

    this.logger.log('received transaction ', transactions)
   
    let userOperation: UserOperation
      // Removing populate transaction all together
      // const tx: TransactionRequest = await this.populateTransaction(transaction)

      transactions.map(this.verifyAllNecessaryFields)


      // let target = transactions.map(({ target }) => target)
     
      const target = transactions.map((element) => element.to ?? ethers.constants.AddressZero)
      const data = transactions.map((element) => element.data ?? '0x')
      const value = transactions.map((element) => element.value ?? BigNumber.from(0))

      userOperation = await this.smartAccountAPI.createSignedUserOp({
        target,
        data,
        value,
      })
    this.logger.log('signed userOp ', userOperation)

    let bundlerServiceResponse: any

    try {
      bundlerServiceResponse = await this.httpRpcClient.sendUserOpToBundler(userOperation)
      this.logger.log('bundlerServiceResponse', bundlerServiceResponse)
    } catch (error) {
      // console.error('sendUserOpToBundler failed', error)
      throw this.unwrapError(error)
    }

    if (clientMessenger && clientMessenger.socketClient.isConnected()) {
      clientMessenger.createTransactionNotifier(bundlerServiceResponse.transactionId, {
        onHashGenerated: async (tx: any) => {
          if (tx) {
            const txHash = tx.transactionHash
            const txId = tx.transactionId
            this.logger.log('Tx Hash generated message received at client', {
              transactionId: txId,
              hash: txHash
            })
            engine &&
              engine.emit('txHashGenerated', {
                id: tx.transactionId,
                hash: tx.transactionHash,
                msg: 'txn hash generated'
              })
          }
        },
        onHashChanged: async (tx: any) => {
          if (tx) {
            const txHash = tx.transactionHash
            const txId = tx.transactionId
            this.logger.log('Tx Hash changed message received at client', {
              transactionId: txId,
              hash: txHash
            })
            engine &&
              engine.emit('txHashChanged', {
                id: tx.transactionId,
                hash: tx.transactionHash,
                msg: 'txn hash changed'
              })
          }
        },
        onError: async (tx: any) => {
          if (tx) {
            this.logger.error('Error message received at client', tx)
            const err = tx.error
            const txId = tx.transactionId
            clientMessenger.unsubscribe(txId)
            // event emitter
            engine &&
              engine.emit('error', {
                id: tx.transactionId,
                error: err,
                msg: 'txn hash generated'
              })
          }
        }
      })
    }

    const transactionResponse = await this.erc4337provider.constructUserOpTransactionResponse(
      userOperation,
      bundlerServiceResponse.transactionId,
      engine
    )
    // const receipt = await transactionResponse.wait()
    // console.log('transactionResponse in sendTransaction', receipt)

    // TODO: handle errors - transaction that is "rejected" by bundler is _not likely_ to ever resolve its "wait()"
    return transactionResponse
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  unwrapError (errorIn: any): Error {
    if (errorIn.body != null) {
      const errorBody = JSON.parse(errorIn.body)
      let paymasterInfo: string = ''
      let failedOpMessage: string | undefined = errorBody?.error?.message
      if (failedOpMessage?.includes('FailedOp') === true) {
        // TODO: better error extraction methods will be needed
        const matched = failedOpMessage.match(/FailedOp\((.*)\)/)
        if (matched != null) {
          const split = matched[1].split(',')
          paymasterInfo = `(paymaster address: ${split[1]})`
          failedOpMessage = split[2]
        }
      }
      const error = new Error(`The bundler has failed to include UserOperation in a batch: ${failedOpMessage} ${paymasterInfo})`)
      error.stack = errorIn.stack
      return error
    }
    return errorIn
  }

  verifyAllNecessaryFields (transactionRequest: TransactionRequest): void {
    if (transactionRequest.to == null) {
      throw new Error('Missing call target')
    }
    if (transactionRequest.data == null && transactionRequest.value == null) {
      // TBD: banning no-op UserOps seems to make sense on provider level
      throw new Error('Missing call data or value')
    }
  }

  connect (provider: Provider): Signer {
    this.logger.log('changing providers connect called', provider)
    throw new Error('changing providers is not supported')
  }

  async getAddress (): Promise<string> {
    if (this.address == null) {
      this.address = await this.erc4337provider.getSenderAccountAddress()
    }
    return this.address
  }

  async signMessage (message: Bytes | string): Promise<string> {
    return await this.originalSigner.signMessage(message)
  }

  async signTransaction (transaction: Deferrable<TransactionRequest>): Promise<string> {
    this.logger.log('signTransaction called', transaction)
    throw new Error('not implemented')
  }

  async signUserOperation (userOperation: UserOperation): Promise<string> {
    const message = await this.smartAccountAPI.getUserOpHash(userOperation)
    return await this.originalSigner.signMessage(message)
  }
}
