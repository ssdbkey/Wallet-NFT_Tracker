import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, LAMPORTS_PER_SOL, PartiallyDecodedInstruction, PublicKey, ParsedConfirmedTransaction, ConfirmedSignatureInfo } from "@solana/web3.js";
import {
  getParsedNftAccountsByOwner
} from "@nfteyez/sol-rayz";
import {
  DIGITALEYES_DIRECTSELL_PROGRAM_PUBKEY,
  DIGITALEYES_PROGRAM_PUBKEY,
  EXCHANGE_PROGRAM_PUBKEY,
  MAGIC_EDEN_PROGRAM_PUBKEY,
  SOLANART_PROGRAM_PUBKEY,
  SOLANA_MAINNET,
  SOLANA_MAINNET_SERUM,
  SOLANA_TRX_FEE, SOLSEA_PROGRAM_PUBKEY,

} from './config/constant';
import axios from "axios";
import { Data } from "@nfteyez/sol-rayz/dist/config/metaplex";
/**
 * Determine NFTs on wallet
 * 
 * Fetch only metadata for each NFT. Price and related transaction info is excepted
 * @param address Wallet address to determine
 * @returns Fetched NFT Accounts with data
 */
export const fetchWalletForNFTs = async (address: string, page: number) => {
  const wallet = new PublicKey(address);
  const connection = new Connection(SOLANA_MAINNET, "confirmed");
  const nftAccounts = await getParsedNftAccountsByOwner({ publicAddress: wallet, connection: connection });
  console.log(`\n${nftAccounts.length} nfts determined from this wallet`);

  // Reduce nftInfos by pagination
  if (nftAccounts.length < page * 10) return {
    total: nftAccounts.length,
    page,
    nfts: []
  };
  let start = page * 10, end: number | undefined = (page + 1) * 10;
  if (end > nftAccounts.length) end = undefined;
  let processingAccounts = nftAccounts.sort((nft_a, nft_b) => { return nft_a.mint > nft_b.mint ? 1 : -1 }).slice(start, end);
  console.log(processingAccounts.map((nft) => nft.mint));

  // Get all token accounts of wallet to get the Token Account for particular mint
  const walletTokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet, { programId: TOKEN_PROGRAM_ID });
  const holderAccount = walletTokenAccounts.value.map(token => {
    return {
      mint: token.account.data.parsed.info.mint,
      account: token.pubkey.toBase58(),
    }
  });

  // Track purchased data parallel
  let result: any[] = [];
  await Promise.allSettled(
    processingAccounts.map(nft => {
      return new Promise(async (resolve, reject) => {
        const purchaseInfo = await trackPurchasedData(address, holderAccount.filter(holder => holder.mint == nft.mint)[0].account);
        result.push({
          ...nft,
          purchase: purchaseInfo,
        });
        resolve(true);
      });
    })
  );

  return ({
    total: nftAccounts.length,
    page,
    nfts: result,
  });
}

/**
 * Get the purchased info for particular nft in wallet
 * @param address user wallet address
 * @param mint nft mint address
 * @returns purchase price and date
 */
export const fetchOnlyPurchaseInfo = async (address: string, mint: string) => {
  var connection = new Connection(SOLANA_MAINNET, "confirmed");

  const nftAccounts = await getParsedNftAccountsByOwner({ publicAddress: new PublicKey(address), connection: connection });

  const walletTokenAccounts = await connection.getParsedTokenAccountsByOwner(new PublicKey(address), { programId: TOKEN_PROGRAM_ID });
  var holderAccountTemp = [];
  for (let i = 0; i < walletTokenAccounts.value.length; i++) {
    for (let j = 0; j < nftAccounts.length; j++) {
      if (walletTokenAccounts.value[i].account.data.parsed.info.mint === nftAccounts[j].mint) {
        holderAccountTemp.push({
          mint: nftAccounts[j].mint,
          account: walletTokenAccounts.value[i].pubkey.toBase58(),
          nftname: nftAccounts[j].data.name,
          nftsymbol: nftAccounts[j].data.symbol,
          nfturi: nftAccounts[j].data.uri,
        });
        break;
      }
    }
  }

  var globalSignLength = [];
  var globalSigns = [];
  var purchaseInfo = [];
  for (let i = 0; i < holderAccountTemp.length; i++) {

    let sigs = await connection.getSignaturesForAddress(new PublicKey(holderAccountTemp[i].account), { limit: 10 });
    globalSignLength.push(sigs.length);
    for (let j = 0; j < sigs.length; j++) {
      globalSigns.push(sigs[j].signature);
    }
  }

  connection = new Connection('https://solana--mainnet.datahub.figment.io/apikey/ba11960d832a6415baeb2ae7e5f6acd3', "confirmed");

  let testtxs = await connection.getParsedConfirmedTransactions(globalSigns, 'confirmed');
  if (testtxs.length > 0 && testtxs[0] === null) {
    console.log('null transaction occoured. retry...');
    testtxs = await connection.getParsedConfirmedTransactions(globalSigns, 'confirmed');
  }
  if (testtxs.length > 0 && testtxs[0] === null) {
    console.log('second null transaction occoured');
    testtxs = await connection.getParsedConfirmedTransactions(globalSigns, 'confirmed');
  }
  var stackedTxsLength = 0;
  for (let i = 0; i < globalSignLength.length; i++) {

    var price = 0;
    var market = '';
    var time = '';
    if (i > 0) stackedTxsLength += globalSignLength[i - 1];
    for (let j = 0; j < globalSignLength[i]; j++) {

      const trx = testtxs[stackedTxsLength + j];
      var signer = trx?.transaction.message.accountKeys[0].pubkey.toBase58();
      if (signer != address) continue;
      if (!trx?.meta) continue;

      let prebalance = trx?.meta?.preBalances[0] as number;
      let postBalances = trx?.meta?.postBalances[0] as number;

      if ((prebalance - postBalances - SOLANA_TRX_FEE) / LAMPORTS_PER_SOL < 0.005) continue;
      else price = (prebalance - postBalances - SOLANA_TRX_FEE) / LAMPORTS_PER_SOL;
      time = (new Date((trx.blockTime ?? 0) * 1000)).toLocaleString();


      var instructionlength = trx?.transaction.message.instructions.length as number;
      for (let k = 0; k < instructionlength; k++) {
        market = '';

        const parsedInstruction = trx?.transaction.message.instructions[k] as PartiallyDecodedInstruction;
        if (!parsedInstruction || !parsedInstruction.data) break;

        const program = parsedInstruction.programId.toBase58();

        //
        if (program == SOLANART_PROGRAM_PUBKEY.toBase58() && parsedInstruction.data.indexOf('54') == 0) {
          console.log(`--> Solanart NFT Sale - ${price} : ${time}`);
          market = 'solanart';
          break;
        } else if (program == MAGIC_EDEN_PROGRAM_PUBKEY.toBase58() && parsedInstruction.data.indexOf('3UjL') == 0) {
          console.log(`--> MagicEden NFT Sale - ${price} : ${time}`);
          market = 'magiceden';
          break;
        } else if (program == DIGITALEYES_PROGRAM_PUBKEY.toBase58() && parsedInstruction.data.indexOf('jz') == 0) {
          console.log(`--> DigitalEye NFT Sale - ${price} : ${time}`);
          market = 'digitaleye';
          break;
        } else if (program == DIGITALEYES_DIRECTSELL_PROGRAM_PUBKEY.toBase58() && parsedInstruction.data.indexOf('xc') == 0) {
          console.log(`--> DigitalEye NFT Direct Sale - ${price} : ${time}`);
          market = 'digitaleye';
        } else if (program == EXCHANGE_PROGRAM_PUBKEY.toBase58() && parsedInstruction.data.indexOf('jzD') == 0) {
          console.log(`--> ExchangeArt NFT Sale - ${price} : ${time}`);
          market = 'exchange';
        } else if (program == SOLSEA_PROGRAM_PUBKEY.toBase58() && parseInt(parsedInstruction.data, 16) > 234) {
          console.log(`--> Solsea NFT Sale - ${price} : ${time}`);
          market = 'solsea';
        } else {
          continue;
        }

      }

    }

    purchaseInfo.push({
      mint: holderAccountTemp[i].mint,
      nftname: holderAccountTemp[i].nftname,
      nftsymbol: holderAccountTemp[i].nftsymbol,
      nfturi: holderAccountTemp[i].nfturi,
      account: holderAccountTemp[i].account,
      price: price == 0 ? 'unknown' : price,
      time: time == '' ? 'unknown' : time,
      market: market != '' ? market : 'unknown',

    });

  }
  console.log('', purchaseInfo.length);

  return ({ purchase: purchaseInfo });

}

type CustomPartiallyDecodedInstruction = {
  /** Program id called by this instruction */
  programIdIndex: number;
  /** Public keys of accounts passed to this instruction */
  accounts: Array<PublicKey>;
  /** Raw base-58 instruction data */
  data: string;
}


/**
 * Track related transactions with the holder account of particular nft for this wallet
 * @param address user wallet address
 * @param holder nft holding account address
 * @returns purchase info or undefined
 */
const trackPurchasedData = async (address: string, holder: string): Promise<{
  price: number,
  time: string,
  market: string,
} | undefined> => {
  return new Promise(async (resolve, reject) => {
    try {
      console.log(`  -> Start purchase track for ${holder}`);
      var connection = new Connection(SOLANA_MAINNET, "confirmed");
      let sigs = await connection.getSignaturesForAddress(new PublicKey(holder), { limit: 10 });
      const sigList = sigs.filter((sig) => sig.err == null).map((info) => {
        return info.signature;
      });
      console.log(`  -> ${sigList.length} sigs are fetched`);

      if (sigList.length == 0) {
        resolve(undefined);
        return undefined;
      }

      connection = new Connection('https://solana--mainnet.datahub.figment.io/apikey/13bd97ce42511f389ad498e31efe58ee', "confirmed");
      let testtxs = await connection.getParsedConfirmedTransactions(sigList, 'confirmed');
      if (testtxs.length > 0 && testtxs[0] === null) {
        console.log('null transaction occoured');
        testtxs = await connection.getParsedConfirmedTransactions(sigList, 'confirmed');
      }
      // console.log(holder, "siglist : ", sigList, "\n testtxs : ", testtxs[0], 'testtxs length : ', testtxs.length);

      testtxs.map((trx) => {
        const signer = trx?.transaction.message.accountKeys[0].pubkey.toBase58();
        if (signer != address) return;
        trx?.transaction.message.instructions.map((transaction) => {
          const parsedTrx = transaction as PartiallyDecodedInstruction;
          if (!parsedTrx || !parsedTrx.data || !trx.meta) return;
          const price = (trx.meta?.preBalances[0] - trx.meta?.postBalances[0] - SOLANA_TRX_FEE) / LAMPORTS_PER_SOL;
          if (price < 0.005) return;
          const time = (new Date((trx.blockTime ?? 0) * 1000)).toLocaleString();
          const program = transaction.programId.toBase58();
          let result = {
            price,
            time,
            market: '',
          };
          if (program == SOLANART_PROGRAM_PUBKEY.toBase58() && parsedTrx.data.indexOf('54') == 0) {
            console.log(`--> Solanart NFT Sale - ${price} : ${time}`);
            result.market = 'solanart';
          } else if (program == MAGIC_EDEN_PROGRAM_PUBKEY.toBase58() && parsedTrx.data.indexOf('3UjL') == 0) {
            console.log(`--> MagicEden NFT Sale - ${price} : ${time}`);
            result.market = 'magiceden';
          } else if (program == DIGITALEYES_PROGRAM_PUBKEY.toBase58() && parsedTrx.data.indexOf('jz') == 0) {
            console.log(`--> DigitalEye NFT Sale - ${price} : ${time}`);
            result.market = 'digitaleye';
          } else if (program == DIGITALEYES_DIRECTSELL_PROGRAM_PUBKEY.toBase58() && parsedTrx.data.indexOf('xc') == 0) {
            console.log(`--> DigitalEye NFT Direct Sale - ${price} : ${time}`);
            result.market = 'digitaleye';
          } else if (program == EXCHANGE_PROGRAM_PUBKEY.toBase58() && parsedTrx.data.indexOf('jzD') == 0) {
            console.log(`--> ExchangeArt NFT Sale - ${price} : ${time}`);
            result.market = 'exchange';
          } else if (program == SOLSEA_PROGRAM_PUBKEY.toBase58() && parseInt(parsedTrx.data, 16) > 234) {
            console.log(`--> Solsea NFT Sale - ${price} : ${time}`);
            result.market = 'solsea';
          } else {
            console.log(`--> unknown market NFT Sale - ${price} : ${time}`);
            result.market = 'unknown';
          }
          resolve(result);
          return;
        });
      })

      resolve(undefined);
    } catch (e) {
      console.log(e);
      resolve(undefined);
    }
  })
};


/**
 * Track related transactions with the holder account of particular nft for this wallet
 * @param address user wallet address
 * @param holder nft holding account address
 * @returns purchase info or undefined
 */
const trackPurchasedDatas = async (address: string): Promise<{
  price: number,
  time: string,
  market: string,
} | undefined> => {
  return new Promise(async (resolve, reject) => {
    try {
      console.log(`  -> Start purchase track for ${address}`);

      const connection = new Connection(SOLANA_MAINNET, "confirmed");

      let sigs = await connection.getSignaturesForAddress(new PublicKey(address), { limit: 10 });
      const sigList = sigs.filter((sig) => sig.err == null).map((info) => {
        return info.signature;
      });
      console.log(`  -> ${sigList.length} sigs are fetched`);

      if (sigList.length == 0) {
        resolve(undefined);
        return undefined;
      }
      console.log('---------------request transaction ------------>');
      for (let i = 0; i < sigList.length; i++) {
        const res = await axios.post(SOLANA_MAINNET, {
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          "params": [
            sigList[i],
            "json"
          ]
        });
        const trx = res?.data.result;
        const signer = new PublicKey(trx?.transaction.message.accountKeys[0]).toBase58();
        if (signer != address) continue;
        (trx?.transaction.message.instructions as CustomPartiallyDecodedInstruction[]).map((transaction) => {
          const parsedTrx = transaction;
          if (!parsedTrx || !parsedTrx.data || !trx.meta) return;
          const price = (trx.meta?.preBalances[0] - trx.meta?.postBalances[0] - SOLANA_TRX_FEE) / LAMPORTS_PER_SOL;
          if (price < 0.005) return;
          const time = (new Date((trx.blockTime ?? 0) * 1000)).toLocaleString();
          const program = new PublicKey(trx?.transaction.message.accountKeys[transaction.programIdIndex]).toBase58();
          let result = {
            price,
            time,
            market: '',
          };
          if (program == DIGITALEYES_PROGRAM_PUBKEY.toBase58() && parsedTrx.data.indexOf('jz') == 0) {
            console.log(`--> DigitalEye NFT Sale - ${price} : ${time}`);
            result.market = 'digitaleye';
          } else if (program == DIGITALEYES_DIRECTSELL_PROGRAM_PUBKEY.toBase58() && parsedTrx.data.indexOf('xc') == 0) {
            console.log(`--> DigitalEye NFT Direct Sale - ${price} : ${time}`);
            result.market = 'digitaleye';
          } else if (program == SOLANART_PROGRAM_PUBKEY.toBase58() && parsedTrx.data.indexOf('54') == 0) {
            console.log(`--> Solanart NFT Sale - ${price} : ${time}`);
            result.market = 'solanart';
          } else if (program == EXCHANGE_PROGRAM_PUBKEY.toBase58() && parsedTrx.data.indexOf('jzD') == 0) {
            console.log(`--> ExchangeArt NFT Sale - ${price} : ${time}`);
            result.market = 'exchange';
          } else if (program == MAGIC_EDEN_PROGRAM_PUBKEY.toBase58() && parsedTrx.data.indexOf('3UjL') == 0) {
            console.log(`--> MagicEden NFT Sale - ${price} : ${time}`);
            result.market = 'magiceden';
          } else if (program == SOLSEA_PROGRAM_PUBKEY.toBase58() && parseInt(parsedTrx.data, 16) > 234) {
            console.log(`--> Solsea NFT Sale - ${price} : ${time}`);
            result.market = 'solsea';
          } else {
            return;
          }
          resolve(result);
          return;
        });

      }

      resolve(undefined);
    } catch (e) {
      console.log(e);
      resolve(undefined);
    }
  })
};
