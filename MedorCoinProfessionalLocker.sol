// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

library SafeERC20 {
    function safeTransferFrom(IERC20 token, address from, address to, uint256 value) internal {
        (bool success, bytes memory returndata) = address(token).call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, value)
        );
        require(
            success && (returndata.length == 0 || (returndata.length >= 32 && abi.decode(returndata, (bool)))),
            "ERC20 transferFrom failed"
        );
    }

    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        (bool success, bytes memory returndata) = address(token).call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, value)
        );
        require(
            success && (returndata.length == 0 || (returndata.length >= 32 && abi.decode(returndata, (bool)))),
            "ERC20 transfer failed"
        );
    }
}

interface IERC721 {
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

abstract contract ReentrancyGuard {
    uint256 private _status = 1;

    modifier nonReentrant() {
        require(_status == 1, "ReentrancyGuard: reentrant call");
        _status = 2;
        _;
        _status = 1;
    }
}

abstract contract Ownable {
    address private _owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor() {
        _owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    modifier onlyOwner() {
        require(msg.sender == _owner, "Ownable: caller is not the owner");
        _;
    }

    function owner() public view returns (address) {
        return _owner;
    }
}

interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    );
}

/**
 * @title MedorCoin Professional Locker
 * @notice Production-grade locker for Tokens and NFTs with dynamic $45 USD fee calculations.
 */
contract MedorCoinProfessionalLocker is ReentrancyGuard, Ownable, IERC721Receiver {
    using SafeERC20 for IERC20;

    struct Lock {
        address owner;
        address token;
        uint256 amountOrId;
        uint256 unlockTime;
        bool isNFT;
        bool active;
    }

    // State Variables
    mapping(uint256 => Lock) public locks;
    mapping(address => uint256[]) private _userLockIds; 
    mapping(address => uint256) public totalLockedPerToken;
    
    uint256 public nextLockId;
    AggregatorV3Interface internal immutable priceFeed;
    uint256 public constant USD_FEE = 45; 
    address payable public treasury;

    // Events
    event TokenLocked(uint256 indexed id, address indexed owner, address indexed token, uint256 amount, uint256 unlockTime);
    event Withdrawn(uint256 indexed id, address indexed owner, uint256 amount);
    event EmergencyRescued(address token, uint256 amount);

    constructor(address _priceFeed, address payable _treasury) Ownable() {
        require(_priceFeed != address(0) && _treasury != address(0), "Invalid Config");
        priceFeed = AggregatorV3Interface(_priceFeed);
        treasury = _treasury;
    }

    /**
     * @notice Standard Mandatory Compliance Callback Function for ERC721 safety
     * Fixed: Resolved broken selector assignment to compile cleanly
     */
    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    /**
     * @notice Calculates the native token amount equivalent to $45 USD via Chainlink.
     */
    function getRequiredPayment() public view returns (uint256) {
        (, int256 price, , uint256 updatedAt, ) = priceFeed.latestRoundData();
        require(price > 0, "Oracle: INVALID_PRICE");
        require(block.timestamp - updatedAt < 86400, "Oracle: STALE_PRICE_FEED");
        
        uint8 decimals = priceFeed.decimals();
        uint256 adjustedPrice = uint256(price) * (10**(18 - decimals));
        return (USD_FEE * 1e18 * 1e18) / adjustedPrice;
    }

    /**
     * @notice Standard Single Lock with $45 USD fee.
     */
    function createLock(
        address _token, 
        uint256 _amountOrId, 
        uint256 _unlockTime, 
        bool _isNFT
    ) external payable nonReentrant {
        uint256 required = getRequiredPayment();
        require(msg.value >= required, "Insufficient $45 fee");
        
        _executeLock(_token, _amountOrId, _unlockTime, _isNFT);
        
        (bool success, ) = treasury.call{value: msg.value}("");
        require(success, "Treasury transfer failed");
    }

    /**
     * @notice Batch Create Locks: Lock multiple assets in one transaction.
     */
    function createBatchLocks(
        address[] calldata _tokens,
        uint256[] calldata _amountsOrIds,
        uint256[] calldata _unlockTimes,
        bool[] calldata _isNFTs
    ) external payable nonReentrant {
        uint256 count = _tokens.length;
        require(count > 0 && count <= 50, "Invalid batch size");
        require(count == _amountsOrIds.length && count == _unlockTimes.length && count == _isNFTs.length, "Array mismatch");

        uint256 singleFee = getRequiredPayment();
        uint256 totalRequired = singleFee * count;
        require(msg.value >= totalRequired, "Insufficient total $45 fees");

        for (uint256 i = 0; i < count; i++) {
            _executeLock(_tokens[i], _amountsOrIds[i], _unlockTimes[i], _isNFTs[i]);
        }

        (bool success, ) = treasury.call{value: msg.value}("");
        require(success, "Treasury transfer failed");
    }

    /**
     * @dev Internal logic for security and gas optimization.
     */
    function _executeLock(address _token, uint256 _amountOrId, uint256 _unlockTime, bool _isNFT) internal {
        require(_token != address(0), "Invalid token address");
        require(_unlockTime > block.timestamp, "Unlock must be in future");
        require(_unlockTime < block.timestamp + 3650 days, "Max lock 10 years");

        if (_isNFT) {
            IERC721(_token).safeTransferFrom(msg.sender, address(this), _amountOrId);
        } else {
            uint256 balBefore = IERC20(_token).balanceOf(address(this));
            IERC20(_token).safeTransferFrom(msg.sender, address(this), _amountOrId);
            uint256 actualAmount = IERC20(_token).balanceOf(address(this)) - balBefore;
            require(actualAmount > 0, "Must lock non-zero token value");
            
            totalLockedPerToken[_token] += actualAmount;
            _amountOrId = actualAmount;
        }

        locks[nextLockId] = Lock({
            owner: msg.sender,
            token: _token,
            amountOrId: _amountOrId,
            unlockTime: _unlockTime,
            isNFT: _isNFT,
            active: true
        });

        _userLockIds[msg.sender].push(nextLockId);
        emit TokenLocked(nextLockId, msg.sender, _token, _amountOrId, _unlockTime);
        nextLockId++;
    }

    /**
     * @notice Withdraw tokens after unlock time.
     */
    function withdraw(uint256 _id) external nonReentrant {
        Lock storage l = locks[_id];
        require(msg.sender == l.owner, "Not authorized");
        require(block.timestamp >= l.unlockTime, "Still locked");
        require(l.active, "Inactive");

        l.active = false;
        uint256 withdrawalAmount = l.amountOrId;
        l.amountOrId = 0;

        if (l.isNFT) {
            IERC721(l.token).safeTransferFrom(address(this), msg.sender, withdrawalAmount);
        } else {
            totalLockedPerToken[l.token] -= withdrawalAmount;
            IERC20(l.token).safeTransfer(msg.sender, withdrawalAmount);
        }
        emit Withdrawn(_id, msg.sender, withdrawalAmount);
    }

    /**
     * @notice Enumeration for frontend
     */
    function getUserLocks(address _user) external view returns (uint256[] memory) {
        return _userLockIds[_user];
    }

    /**
     * @notice Rescue tokens accidentally sent to contract (cannot touch user-locked funds).
     * Fixed: Shifted native coin rescue loops to safe low-level execution calls to handle custom multi-sig ownership blocks
     */
    function rescueExcessTokens(address _token, uint256 _amount) external onlyOwner {
        uint256 contractBalance = (_token == address(0)) ? address(this).balance : IERC20(_token).balanceOf(address(this));
        uint256 rescuable = contractBalance - totalLockedPerToken[_token];
        require(_amount <= rescuable, "Cannot rescue user funds");

        if (_token == address(0)) {
            (bool success, ) = payable(owner()).call{value: _amount}("");
            require(success, "Emergency native coin rescue failed");
        } else {
            IERC20(_token).safeTransfer(owner(), _amount);
        }
        emit EmergencyRescued(_token, _amount);
    }
}
