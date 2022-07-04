import { MultiSendContract } from 'core-types'
import {
  MultiSendContract as MultiSend_TypeChain,
  MultiSendContractInterface
} from '../../../typechain/src/ethers-v5/v1.0.0/MultiSendContract'

class MultiSendEthersContract implements MultiSendContract {
  constructor(public contract: MultiSend_TypeChain) {}

  encode: MultiSendContractInterface['encodeFunctionData'] = (methodName: any, params: any): string => {
    return this.contract.interface.encodeFunctionData(methodName, params)
  }
}

export default MultiSendEthersContract
